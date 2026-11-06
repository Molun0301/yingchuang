const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { discover } = require('./discovery.cjs');
const { Store } = require('./store.cjs');
const { defaultDraft, makeTemplate, applyTemplate, cleanLayout } = require('./model.cjs');
const { ConversionQueue } = require('./queue.cjs');
const { evaluateScene } = require('./scenescript.cjs');
const devices = require('./devices.json');

protocol.registerSchemesAsPrivileged([{ scheme: 'yingchuang', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
if (process.env.YINGCHUANG_DATA_DIR) app.setPath('userData', process.env.YINGCHUANG_DATA_DIR);
if (process.env.YINGCHUANG_DISABLE_GPU === '1') app.disableHardwareAcceleration();
app.setName('映窗');
let window, store, queue;
let library = { themes: [], roots: [], engineRoots: [] };
let previewController = null;
const registeredRoots = new Map();
const rootIds = new Map();
const processes = new Set();
const inspections = new Map();
const scriptCache = new Map();
const apiHandlers = new Map();
let browserPreview;
let systemFonts;

function assetRoot(root) {
  if (!root) return '';
  const absolute = path.resolve(root);
  if (!rootIds.has(absolute)) {
    const id = randomUUID(); rootIds.set(absolute,id); registeredRoots.set(id,absolute);
  }
  return process.env.YINGCHUANG_PREVIEW_PORT ? `http://127.0.0.1:${process.env.YINGCHUANG_PREVIEW_PORT}/asset/${rootIds.get(absolute)}/` : `yingchuang://asset/${rootIds.get(absolute)}/`;
}
function fileUrl(file) { return file ? assetRoot(path.dirname(file)) + encodeURIComponent(path.basename(file)) : ''; }
function previewData(data) { return { ...data, ...('assetRoot' in data?{assetRoot:assetRoot(data.assetRoot)}:{}), ...('clockRoot' in data?{clockRoot:assetRoot(data.clockRoot)}:{}), ...(data.videoSource?{videoSource:fileUrl(data.videoSource)}:{}) }; }
function stopWorker(child) {
  if (!child.pid) return;
  if (process.platform==='win32') { spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>child.kill()); }
  else { try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');} }
}
function themeById(id) {
  const theme = library.themes.find(x => x.id === id);
  if (!theme) throw new Error('主题已移走，请刷新壁纸库。');
  return theme;
}
function deviceById(id) { return devices.find(x => x.id === id) || devices[devices.length-1]; }
function publicTheme(theme) {
  return { id: theme.id, title: theme.title, type: theme.type, preview: fileUrl(theme.preview),
    author: theme.author, workshopId: theme.workshopId, modified: theme.modified,
    propertyCount: theme.properties.filter(x => !['text','group'].includes(x.type)).length };
}
function state() {
  return { ...store.snapshot(), themes: library.themes.map(publicTheme), roots: library.roots,
    devices, queue: queue.snapshot(), platform: process.platform, version: app.getVersion() };
}
function notify(channel,data) { if (window && !window.isDestroyed()) window.webContents.send(channel,data);browserPreview?.emit(channel,data); }

async function worker(input, signal, onProgress = () => {}) {
  if (signal?.aborted) throw new Error('已取消');
  const core = app.isPackaged ? path.join(process.resourcesPath,'core') : path.join(__dirname,'../core');
  const cacheRoot = path.join(app.getPath('userData'),'cache');
  const jobsRoot = path.join(app.getPath('userData'),'jobs');
  await fs.mkdir(jobsRoot,{recursive:true});
  const scratchRoot = await fs.mkdtemp(path.join(jobsRoot,'job-'));
  let exportStagingRoot;
  let command, args;
  if (app.isPackaged && process.platform === 'linux') {
    command = path.join(process.resourcesPath,'runtime/converter-worker'); args = [];
  } else {
    const localPython=path.join(__dirname,process.platform==='win32'?'../.venv/Scripts/python.exe':'../.venv/bin/python');
    command = app.isPackaged ? path.join(process.resourcesPath,'runtime/python.exe') : (process.env.YINGCHUANG_PYTHON || (existsSync(localPython)?localPython:'python3'));
    args = ['-I','-X','utf8','-u',path.join(core,'应用桥接.py')];
  }
  try {
    if(input.operation==='export'){
      await fs.mkdir(input.outputDirectory,{recursive:true});
      exportStagingRoot=await fs.mkdtemp(path.join(input.outputDirectory,'.yingchuang-'));
    }
    return await new Promise((resolve,reject) => {
      const child = spawn(command,args,{ windowsHide:true, detached:process.platform!=='win32', stdio:['pipe','pipe','pipe'],
        env:{ ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1', YINGCHUANG_CORE:core, OPENBLAS_NUM_THREADS:'2', IMAGEIO_FFMPEG_NO_PREVENT_SIGINT:'1' } });
      processes.add(child);
      let buffer='', errors='', result, failure;
      const abort = () => stopWorker(child);
      signal?.addEventListener('abort',abort,{once:true});
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data',chunk => {
        buffer += chunk;
        const lines = buffer.split('\n'); buffer=lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const item=JSON.parse(line);
            if (item.event==='progress') onProgress(item);
            if (item.event==='result') result=item.result;
            if (item.event==='error') failure=item.message;
          } catch { errors += line+'\n'; }
        }
      });
      child.stderr.on('data',chunk => { errors=(errors+chunk).slice(-12000); });
      child.on('error',error => { failure=error.message; });
      child.on('close',async code => {
        processes.delete(child);signal?.removeEventListener('abort',abort);
        if(input.operation==='export'&&result===undefined){
          try{const committed=JSON.parse(await fs.readFile(path.join(scratchRoot,'job-result.json'),'utf8'));await fs.access(committed.path);result=committed;}catch{}
        }
        if(input.operation==='export'&&result!==undefined)resolve(result);
        else if (signal?.aborted) reject(new Error('已取消'));
        else if (code!==0 || result===undefined) reject(new Error(failure || errors.trim().split('\n').pop() || '转换进程未完成。'));
        else resolve(result);
      });
      child.stdin.on('error',()=>{});
      child.stdin.end(JSON.stringify({ ...input,cacheRoot,scratchRoot,exportStagingRoot })+'\n');
      if (signal?.aborted) abort();
    });
  } finally {
    await fs.rm(scratchRoot,{recursive:true,force:true});
    if(exportStagingRoot)await fs.rm(exportStagingRoot,{recursive:true,force:true,maxRetries:3,retryDelay:100});
  }
}

async function inspect(theme) {
  if (!inspections.has(theme.id)) inspections.set(theme.id,worker({operation:'inspect',theme}));
  try { return await inspections.get(theme.id); }
  catch(error) { inspections.delete(theme.id); throw error; }
}
async function withScripts(theme,draft,signal) {
  if(theme.type!=='scene')return theme;
  const stat=await fs.stat(theme.source);
  const key=JSON.stringify([theme.id,stat.mtimeMs,stat.size,draft.properties,Math.floor(Date.now()/60000)]);
  if(scriptCache.has(key))return{...theme,...scriptCache.get(key)};
  const input=await worker({operation:'script-input',theme,draft:{...draft,layers:{}}},signal);
  if(signal?.aborted)throw new Error('已取消');
  const result=await evaluateScene(input);
  const graphicsScene={...result.scene,objects:result.scene.objects.filter(o=>!input.clockLayerIds.includes(o.id))};
  const value={resolvedScene:result.scene,scriptSignature:createHash('sha256').update(JSON.stringify(graphicsScene)).digest('hex'),scriptResult:{errors:result.errors,clockFormats:result.clockFormats||{},evaluated:result.evaluated,total:result.total}};
  scriptCache.set(key,value);if(scriptCache.size>12)scriptCache.delete(scriptCache.keys().next().value);
  return{...theme,...value};
}
async function draftFor(theme) {
  const saved = store.data.drafts[theme.id];
  if (saved) return structuredClone(saved);
  const detail = await inspect(theme);
  return defaultDraft(theme.propertyValues,detail.hasClock,store.data.settings.deviceId);
}
async function ensureClockFont(theme,draft) {
  if(!draft.layout.clock.enabled)return draft;
  const detail=await inspect(theme);
  if(detail.fontIssue||Object.keys(detail.sourceFonts||{}).length)return draft;
  const available=await(systemFonts ||= worker({operation:'fonts'}));
  const regular=available.filter(f=>!/Bold|Black|Italic|Heavy|粗|斜/i.test(f.label));
  let chosen;
  for(const pattern of [/MiSans/i,/Microsoft YaHei|微软雅黑/i,/Noto Sans CJK|思源黑体/i,/DejaVu Sans$/i]){chosen=regular.find(f=>pattern.test(f.label));if(chosen)break;}
  chosen ||= regular[0]||available[0];
  if(chosen)for(const key of ['week','date','time'])if(!draft.appearance.fonts[key])draft.appearance.fonts[key]=chosen.value;
  return draft;
}
async function scan() {
  library = await discover(store.data.settings.roots);
  inspections.clear();
  scriptCache.clear();
  return state();
}

function handle(name,callback) {
  apiHandlers.set(name,callback);
  ipcMain.handle(name,async(event,...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error('请求来源无效。');
    const result=await callback(...args);
    if(process.env.YINGCHUANG_DIAGNOSTICS&&name==='bootstrap')console.log('桌面界面已连接：'+result.themes.length+' 个主题');
    return result;
  });
}

async function setup() {
  store = new Store(app.getPath('userData'));
  if (!store.data.settings.outputDirectory) {
    store.data.settings.outputDirectory = path.join(app.getPath('documents'),'映窗导出');
    store.save();
  }
  queue = new ConversionQueue(async(input,signal,progress) => {
    progress({phase:'读取主题设置',progress:3});
    const theme=await withScripts(input.theme,input.draft,signal);
    return worker({ ...input,theme,operation:'export' },signal,progress);
  });
  queue.on('change',snapshot => notify('queue-change',snapshot));
  protocol.handle('yingchuang',async request => {
    const url = new URL(request.url);
    const pieces = url.pathname.slice(1).split('/');
    const root = registeredRoots.get(pieces.shift());
    if (!root) return new Response('Not found',{status:404});
    const relative = pieces.map(x=>decodeURIComponent(x)).join('/');
    const target = path.resolve(root,relative);
    if (target!==root && !target.startsWith(root+path.sep)) return new Response('Not found',{status:404});
    try {
      const real = await fs.realpath(target);
      const realRoot = await fs.realpath(root);
      if (real!==realRoot && !real.startsWith(realRoot+path.sep)) return new Response('Not found',{status:404});
      return net.fetch(pathToFileURL(real).href);
    } catch { return new Response('Not found',{status:404}); }
  });

  handle('bootstrap',async() => library.themes.length ? state() : scan());
  handle('refresh',scan);
  handle('detail',async id => {
    const theme=themeById(id);
    return { theme:publicTheme(theme), properties:theme.properties, detail:await inspect(theme), draft:await draftFor(theme) };
  });
  handle('fonts',() => systemFonts ||= worker({operation:'fonts'}));
  handle('save-draft',(id,draft) => {
    themeById(id);
    store.update(data=> { data.drafts[id]={...structuredClone(draft),layout:cleanLayout(draft.layout)}; });
    return store.data.drafts[id];
  });
  handle('preview',async(id,draft) => {
    previewController?.abort(); previewController=new AbortController();
    const controller=previewController;
    const theme=await withScripts(themeById(id),draft,controller.signal);
    const data=await worker({operation:'preview',theme,draft,device:deviceById(draft.deviceId)},controller.signal,
      event=>notify('preview-progress',{id,...event}));
    return previewData(data);
  });
  handle('cancel-preview',()=>previewController?.abort());
  handle('clock',async(id,draft)=>previewData(await worker({operation:'clock',theme:await withScripts(themeById(id),draft),draft,device:deviceById(draft.deviceId)})));
  handle('favorite',id=>store.update(data=>{
    themeById(id); data.favorites=data.favorites.includes(id)?data.favorites.filter(x=>x!==id):[...data.favorites,id];
  }));
  handle('save-template',(name,layout)=>store.update(data=>data.templates.push(makeTemplate(name,layout))));
  handle('delete-template',id=>store.update(data=> { data.templates=data.templates.filter(x=>x.id!==id); }));
  handle('apply-template',async(ids,templateId)=>{
    const template=store.snapshot().templates.find(x=>x.id===templateId);
    if (!template) throw new Error('排版模板不存在。');
    for (const id of ids){const theme=themeById(id);store.data.drafts[id]=await ensureClockFont(theme,applyTemplate(await draftFor(theme),template));}
    store.save();return state();
  });
  handle('settings',input=>store.update(data=>{
    if (typeof input.deviceId==='string') data.settings.deviceId=deviceById(input.deviceId).id;
    if (typeof input.outputDirectory==='string') data.settings.outputDirectory=input.outputDirectory;
  }));
  handle('choose-directory',async purpose=>{
    const selection=await dialog.showOpenDialog(window,{title:purpose==='output'?'选择导出位置':'添加壁纸目录',properties:['openDirectory','createDirectory']});
    if (selection.canceled) return null;
    const folder=selection.filePaths[0];
    store.update(data=>{
      if (purpose==='output') data.settings.outputDirectory=folder;
      else if (!data.settings.roots.includes(folder)) data.settings.roots.push(folder);
    });
    return purpose==='output'?state():scan();
  });
  handle('remove-directory',async folder=>{store.update(data=>{data.settings.roots=data.settings.roots.filter(x=>x!==folder);});return scan();});
  handle('choose-file',async kind=>{
    const selection=await dialog.showOpenDialog(window,{title:kind==='font'?'选择字体':kind==='directory'?'选择目录':'选择文件',properties:[kind==='directory'?'openDirectory':'openFile'],
      filters:kind==='font'?[{name:'字体',extensions:['ttf','otf','ttc']}]:[{name:'所有文件',extensions:['*']}]});
    return selection.canceled?null:selection.filePaths[0];
  });
  handle('enqueue',async({ids,templateId,deviceId})=>{
    const template=store.snapshot().templates.find(x=>x.id===templateId);
    const inputs=[];
    for (const id of [...new Set(ids)]) {
      const theme=themeById(id);let draft=await draftFor(theme);
      if (template) draft=applyTemplate(draft,template);
      draft=await ensureClockFont(theme,draft);
      if (deviceId) draft.deviceId=deviceById(deviceId).id;
      inputs.push({theme,draft,device:deviceById(draft.deviceId),outputDirectory:store.data.settings.outputDirectory});
    }
    return queue.add(inputs);
  });
  handle('cancel-queue',id=>{queue.cancel(id);return queue.snapshot();});
  handle('clear-queue',()=>{queue.clear();return queue.snapshot();});
  handle('open-theme',id=>shell.openPath(themeById(id).folder));
  handle('open-output',async id=>{
    const item=queue.items.find(x=>x.id===id);
    const folder=item?.folder||store.data.settings.outputDirectory;
    await fs.mkdir(folder,{recursive:true});return shell.openPath(folder);
  });
  handle('window-control',action=>{
    if (action==='minimize') window.minimize();
    if (action==='maximize') window.isMaximized()?window.unmaximize():window.maximize();
    if (action==='close') window.close();
  });
  window = new BrowserWindow({ width:1440,height:960,minWidth:1000,minHeight:680,show:false,frame:false,
    backgroundColor:'#edf0f4',title:'映窗',icon:path.join(__dirname,'../build/icon.png'),
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true} });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{
    if (url!==window.webContents.getURL()) event.preventDefault();
  });
  window.once('ready-to-show',()=>window.show());
  const dev=process.env.YINGCHUANG_DEV_URL;
  if (dev) await window.loadURL(dev);
  else await window.loadFile(path.join(__dirname,'../dist/index.html'));
  if (!app.isPackaged && process.env.YINGCHUANG_PREVIEW_PORT) {
    browserPreview = require('../scripts/browser-preview.cjs').start({port:Number(process.env.YINGCHUANG_PREVIEW_PORT),handlers:apiHandlers,roots:registeredRoots,dist:path.join(__dirname,'../dist')});
  }
  if (process.env.YINGCHUANG_SMOKE_EXIT) setTimeout(()=>app.quit(),Number(process.env.YINGCHUANG_SMOKE_EXIT));
}
if(app.requestSingleInstanceLock())app.whenReady().then(setup).catch(error=>{console.error(error);app.quit();});
else app.quit();
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',()=>{
  previewController?.abort();queue?.cancel();
  for (const child of processes) stopWorker(child);
});
