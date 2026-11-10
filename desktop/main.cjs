const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, screen, nativeTheme, desktopCapturer } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { discover } = require('./discovery.cjs');
const { Store } = require('./store.cjs');
const { defaultDraft, makeTemplate, applyTemplate, cleanLayout, exportSettings } = require('./model.cjs');
const { ConversionQueue } = require('./queue.cjs');
const { evaluateScene, sceneEvaluator, scriptInput } = require('./scenescript.cjs');
const { installRecorderHandlers, record, bake } = require('./recorder.cjs');
const { frameScene, recordSize } = require('./framing.cjs');
const { planTimeVariants, localMinute } = require('./timevariants.cjs');
const devices = require('./devices.json');

protocol.registerSchemesAsPrivileged([{ scheme: 'yingchuang', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
if (process.env.YINGCHUANG_DATA_DIR) app.setPath('userData', process.env.YINGCHUANG_DATA_DIR);
if (process.env.YINGCHUANG_DISABLE_GPU === '1') app.disableHardwareAcceleration();
// 图形进程是单线程的：按垂直同步提交界面画面时，显示器休眠后每次提交会阻塞约 1 秒，隐藏窗口逐层渲染的每次读回都要排队等待。
// 关闭垂直同步后界面仍按显示器刷新率出帧，烘焙不再被阻塞。
app.commandLine.appendSwitch('disable-gpu-vsync');
app.setName('映窗');
let window, store, queue;
let library = { themes: [], roots: [], engineRoots: [] };
let previewController = null;
let pendingMotion;
let prefetching=null;
const registeredRoots = new Map();
const rootIds = new Map();
const processes = new Set();
const activeTasks = new Set();
let shuttingDown=false,quitReady=false;
const inspections = new Map();
const scriptCache = new Map();
const timeCache = new Map();
const apiHandlers = new Map();
let browserPreview;
let systemFonts;
let ffmpegPath;
const FULL_TYPES = new Set(['scene', 'web', 'application']);

function assetRoot(root) {
  if (!root) return '';
  const absolute = path.resolve(root);
  if (!rootIds.has(absolute)) {
    const id = randomUUID(); rootIds.set(absolute,id); registeredRoots.set(id,absolute);
  }
  return process.env.YINGCHUANG_PREVIEW_PORT ? `http://127.0.0.1:${process.env.YINGCHUANG_PREVIEW_PORT}/asset/${rootIds.get(absolute)}/` : `yingchuang://asset/${rootIds.get(absolute)}/`;
}
function fileUrl(file) { return file ? assetRoot(path.dirname(file)) + encodeURIComponent(path.basename(file)) : ''; }
function rootId(root) { assetRoot(root); return rootIds.get(path.resolve(root)); }
/** 渲染页与主题资源同属 yingchuang://live，网页壁纸可注入属性接口；主界面是另一来源，壁纸脚本无法触及。 */
function liveBase() { return process.env.YINGCHUANG_PREVIEW_PORT ? `http://127.0.0.1:${process.env.YINGCHUANG_PREVIEW_PORT}/live/` : 'yingchuang://live/'; }
function liveRoot(root) { return root ? liveBase() + 'r/' + rootId(root) + '/' : ''; }
function rendererUrl() { return liveBase() + 'app/renderer.html'; }
function liveTheme(theme) {
  const project = theme.project || {};
  return { key: theme.id + ':' + theme.modified, type: theme.type, base: liveRoot(theme.folder), engine: liveRoot(theme.engineRoots?.[0]),
    file: project.file || path.basename(theme.source), pkg: path.basename(theme.source).toLowerCase() === 'scene.pkg', project };
}
/** 启动底色与上次的配色一致，避免深色界面打开时闪白 */
function darkStart() { const scheme=store.data.settings.appearance?.scheme; return scheme==='dark'||(scheme!=='light'&&nativeTheme.shouldUseDarkColors); }
function cleanAppearance(input) {
  return { material:input.material==='frosted'?'frosted':'liquid', scheme:['light','dark'].includes(input.scheme)?input.scheme:'system',
    ambient:input.ambient!==false, density:input.density==='compact'?'compact':'comfortable' };
}
/** 应用壁纸要在本机运行后录制窗口：Windows 运行 exe，其他系统只运行本地可执行程序 */
function fullAvailable(theme) { return FULL_TYPES.has(theme.type) && (theme.type !== 'application' || process.platform === 'win32' || !/\.exe$/i.test(theme.source)); }
/** 默认图层模式；只有用户选择录制、或主题无法按图层转换时才录制完整画面 */
async function exportMode(theme, draft) {
  if (draft.export?.mode === 'record' && fullAvailable(theme)) return 'record';
  if ((await inspect(theme)).renderable) return 'layers';
  return fullAvailable(theme) ? 'record' : 'layers';
}
function previewData(data) {
  return {...data,...('assetRoot'in data?{assetRoot:assetRoot(data.assetRoot)}:{}),...('clockRoot'in data?{clockRoot:assetRoot(data.clockRoot)}:{}),
    ...(data.layers?{layers:data.layers.map(layer=>({...layer,...(layer.videoSource||layer.video?{videoSource:fileUrl(layer.videoSource||path.join(data.assetRoot,layer.video))}:{})}))}:{})};
}
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

function worker(...args) {
  if(shuttingDown)return Promise.reject(new Error('应用正在关闭'));
  const task=runWorker(...args);activeTasks.add(task);
  task.then(()=>activeTasks.delete(task),()=>activeTasks.delete(task));
  return task;
}

/** 启动一个转换进程：模块导入在读取请求之前完成，所以可以提前启动备用 */
function launchWorker() {
  const core = app.isPackaged ? path.join(process.resourcesPath,'core') : path.join(__dirname,'../core');
  let command, args;
  if (app.isPackaged && process.platform === 'linux') {
    command = path.join(process.resourcesPath,'runtime/converter-worker'); args = [];
  } else {
    const localPython=path.join(__dirname,process.platform==='win32'?'../.venv/Scripts/python.exe':'../.venv/bin/python');
    command = app.isPackaged ? path.join(process.resourcesPath,'runtime/python.exe') : (process.env.YINGCHUANG_PYTHON || (existsSync(localPython)?localPython:'python3'));
    args = ['-I','-X','utf8','-u',path.join(core,'应用桥接.py')];
  }
  const child = spawn(command,args,{ windowsHide:true, detached:process.platform!=='win32', stdio:['pipe','pipe','pipe'],
    env:{ ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1', YINGCHUANG_CORE:core,
      YINGCHUANG_RUNTIME:app.isPackaged?path.join(process.resourcesPath,'runtime'):path.join(__dirname,'../runtime',process.platform==='win32'?'win':'linux'),
      IMAGEIO_FFMPEG_EXE:path.join(app.isPackaged?path.join(process.resourcesPath,'runtime'):path.join(__dirname,'../runtime',process.platform==='win32'?'win':'linux'),process.platform==='win32'?'ffmpeg.exe':'ffmpeg'),
      OPENBLAS_NUM_THREADS:'2', IMAGEIO_FFMPEG_NO_PREVENT_SIGINT:'1' } });
  child.on('error',()=>{});
  return child;
}
// 保持两个已完成 Python 模块导入的备用进程：打开编辑器时同时发出的几个请求都不必等进程冷启动。
const spareWorkers=[];
function takeWorker() {
  let child;
  while(spareWorkers.length&&!child){const item=spareWorkers.shift();if(item.exitCode===null&&!item.killed)child=item;}
  child ||= launchWorker();
  setImmediate(fillSpares);
  return child;
}
function fillSpares() {
  if(shuttingDown)return;
  for(let i=spareWorkers.filter(item=>item.exitCode===null).length;i<2;i++)spareWorkers.push(launchWorker());
}

async function runWorker(input, signal, onProgress = () => {}) {
  const started=performance.now();
  if (signal?.aborted) throw new Error('已取消');
  const cacheRoot = path.join(app.getPath('userData'),'cache');
  const jobsRoot = path.join(app.getPath('userData'),'jobs');
  await fs.mkdir(jobsRoot,{recursive:true});
  const scratchRoot = await fs.mkdtemp(path.join(jobsRoot,'job-'));
  let exportStagingRoot;
  try {
    if(input.operation==='export'){
      await fs.mkdir(input.outputDirectory,{recursive:true});
      exportStagingRoot=await fs.mkdtemp(path.join(input.outputDirectory,'.yingchuang-'));
    }
    return await new Promise((resolve,reject) => {
      const child = takeWorker();
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
    if(process.env.YINGCHUANG_DIAGNOSTICS)console.log('工作进程 '+input.operation+' '+Math.round(performance.now()-started)+' ms');
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
  const detail=await inspect(theme);
  // 透视等原生图层无法解析的场景只走完整画面，脚本由渲染页自行执行。
  if(!detail.scriptInput)return theme;
  const input=scriptInput(detail.scriptInput,draft.properties);
  if(signal?.aborted)throw new Error('已取消');
  const result=await evaluateScene(input);
  const graphicsScene={...result.scene,objects:result.scene.objects.filter(o=>!input.clockLayerIds.includes(o.id))};
  const value={resolvedScene:result.scene,scriptSignature:createHash('sha256').update(JSON.stringify(graphicsScene)).digest('hex'),scriptResult:{errors:result.errors,clockFormats:result.clockFormats||{},evaluated:result.evaluated,total:result.total}};
  scriptCache.set(key,value);if(scriptCache.size>12)scriptCache.delete(scriptCache.keys().next().value);
  return{...theme,...value};
}
/**
 * 随时段变化：壁纸脚本（原时钟文字层以外）读取时间时，一天内采样求值，找出随时段变化的对象及各状态的透明度。
 * 结果按主题、设置与日期缓存；没有变化时返回 null。
 */
async function timeVariantsFor(theme,draft,signal) {
  if(theme.type!=='scene')return null;
  const detail=await inspect(theme);
  if(!detail.scriptInput)return null;
  const clock=new Set(detail.scriptInput.clockLayerIds);
  if(!/engine\.timeOfDay|new Date|Date\.now|getHours|getMinutes/.test(JSON.stringify(detail.scriptInput.scene.objects.filter(o=>!clock.has(o.id)))))return null;
  const stat=await fs.stat(theme.source);
  const key=JSON.stringify([theme.id,stat.mtimeMs,stat.size,draft.properties,new Date().toDateString()]);
  if(!timeCache.has(key)){
    // 同一解释器反复按不同时刻求值，脚本运行时与场景只载入一次。
    timeCache.set(key,(async()=>{
      const evaluator=await sceneEvaluator(scriptInput(detail.scriptInput,draft.properties));
      try{return await planTimeVariants(async minute=>{if(signal?.aborted)throw new Error('已取消');return evaluator.evaluate(localMinute(minute)).scene;},clock);}
      finally{evaluator.dispose();}
    })());
    if(timeCache.size>8)timeCache.delete(timeCache.keys().next().value);
  }
  try{return await timeCache.get(key);}catch(error){timeCache.delete(key);throw error;}
}
/** 把各状态代表时刻的烘焙结果并入时段变体，交给转换进程 */
function withBaked(variants,byScene) {
  return {scenes:variants.scenes,objects:Object.fromEntries(Object.entries(variants.objects).map(([id,list])=>[id,list.map(v=>({scene:v.scene,alpha:v.alpha,baked:byScene[v.scene]?.[id]??null}))]))};
}
/** 完整画面打开前的场景覆盖：隐藏原时钟文字层，图层编辑与用户字体映射到渲染页可读的地址 */
async function livePatch(theme,draft) {
  const detail=await inspect(theme);
  const layers={},fonts={};
  for(const [id,edit] of Object.entries(draft.layers||{})){
    const copy={...edit};
    if(typeof copy.font==='string'&&copy.font&&!copy.font.startsWith('theme:')){
      const name='yingchuang-font/'+createHash('sha256').update(copy.font).digest('hex').slice(0,16)+path.extname(copy.font).toLowerCase();
      fonts[name]=liveRoot(path.dirname(copy.font))+encodeURIComponent(path.basename(copy.font));copy.font=name;
    }
    layers[id]=copy;
  }
  return {hidden:detail.clockLayerIds||[],layers,fonts};
}
async function recordTheme(input,signal,progress) {
  const {theme,draft,device}=input;
  if(theme.type==='application')return recordApplication(input,signal,progress);
  const detail=await inspect(theme);
  const [sceneWidth,sceneHeight]=theme.type==='scene'&&detail.sourceSize?detail.sourceSize:[1920,1080];
  const settings=exportSettings(draft);
  const framing=frameScene(sceneWidth,sceneHeight,device.width,device.height,draft.layout,draft.motion.amount,draft.motion.vertical);
  const size=recordSize(device.width,device.height,framing);
  const full={width:Math.ceil(sceneWidth*framing.scale),height:Math.ceil(sceneHeight*framing.scale)};
  const crop={...size,x:Math.round(-device.width*framing.marginX-framing.left),y:Math.round(-device.height*framing.marginY-framing.top)};
  crop.x=Math.max(0,Math.min(crop.x,full.width-crop.width));crop.y=Math.max(0,Math.min(crop.y,full.height-crop.height));
  const fade=settings.loop?Math.round(settings.fade*settings.fps):0;
  const job={theme:liveTheme(theme),properties:draft.properties,patch:await livePatch(theme,draft),playing:true,dpr:1,
    mode:theme.type==='scene'?'step':'realtime',fps:settings.fps,frames:Math.round(settings.duration*settings.fps)+fade,fade,
    warmup:Math.round(2*settings.fps),sceneWidth,sceneHeight,full,crop};
  ffmpegPath ||= (await worker({operation:'ffmpeg'})).path;
  const output=path.join(app.getPath('userData'),'jobs','record-'+randomUUID()+'.mp4');
  progress({phase:'载入完整画面',progress:6});
  return record({job,output,ffmpeg:ffmpegPath,rendererUrl:rendererUrl(),signal,
    onProgress:share=>progress({phase:'录制完整画面',progress:Math.round(8+share*72)})});
}
/** 启动应用壁纸，找到它新开的窗口后实时采集画面；录制结束即结束整个进程树 */
// 逐层烘焙参数：每层 4 秒循环、15 帧每秒，末尾半秒与开头交叉衔接；显示前先运行 1 秒让粒子铺开。
// version 随烘焙算法变化递增，使旧缓存失效。
const BAKE={fps:15,seconds:4,fade:.5,warmup:1,version:8};
/**
 * 图层模式下由 WebGL 渲染器逐层还原 Python 无法精确转换的图层，结果按内容缓存，预览与导出共用。
 * 返回值交给转换进程的 baked 字段。
 */
/**
 * 逐层烘焙。不随时段变化的图层按当前时刻渲染；随时段变化的图层在各状态的代表时刻分别渲染。
 * 返回 {baked, byScene}：byScene[场景下标][对象编号] 为该时段变体的烘焙记录。
 */
async function bakeLayers(theme,draft,device,signal,progress,variants) {
  const varying=new Set(Object.keys(variants?.objects||{}).map(Number));
  const scenes=varying.size?variants.scenes:[];
  // 当前时刻与各时段状态的规划在同一个转换进程里完成。
  const [plan,...scenePlans]=await worker({operation:'layer-plans',theme,draft,device,varying:[...varying],scenes:[theme.resolvedScene??null,...scenes]},signal);
  const particles=list=>new Set(list.targets.filter(t=>t.kind==='particle').map(t=>t.id));
  // 合成层连同下方图层渲染成一层，下方图层不再单独输出。
  const members=Object.fromEntries(plan.targets.filter(t=>t.members).map(t=>[t.id,t.members]));
  const groups=[{targets:plan.targets.map(t=>t.id).filter(id=>!varying.has(id)),particles:particles(plan),members,resolved:theme.resolvedScene}];
  scenePlans.forEach((scenePlan,index)=>{
    const ids=new Set(Object.entries(variants.objects).filter(([,list])=>list.some(v=>v.scene===index)).map(([id])=>Number(id)));
    groups.push({scene:index,minute:variants.minutes[index],targets:scenePlan.targets.map(t=>t.id).filter(id=>ids.has(id)),particles:particles(scenePlan),members:{},resolved:scenes[index]});
  });
  const prepared=await Promise.all(groups.filter(group=>group.targets.length).map(group=>cachedGroup(theme,draft,device,group)));
  const pending=prepared.filter(entry=>entry.missing.length);
  const total=prepared.reduce((sum,entry)=>sum+entry.group.targets.length,0),cached=total-pending.reduce((sum,entry)=>sum+entry.missing.length,0);
  if(pending.length){
    // 各时段状态缺少的图层一起分给多个窗口并行渲染，窗口数按处理器核数决定。
    const windows=Math.min(8,Math.max(2,Math.floor(os.cpus().length/4)));
    const results=await bake({tasks:pending.map(entry=>({job:entry.job,dirs:entry.dirs})),rendererUrl:rendererUrl(),signal,windows,onProgress:share=>progress((cached+share*(total-cached))/total)});
    await Promise.all(pending.map((entry,k)=>Promise.all(entry.missing.map(async id=>{
      entry.result[id]=results[k][id]||{empty:true};
      await fs.mkdir(entry.dirs[id],{recursive:true});await fs.writeFile(path.join(entry.dirs[id],'baked.json'),JSON.stringify(entry.result[id]));
    }))));
    await pruneBakes(new Set(prepared.flatMap(entry=>Object.values(entry.dirs))));
  }
  progress(1);
  const baked={},byScene={};
  for(const {group,result} of prepared)if(group.minute===undefined)Object.assign(baked,result);else byScene[group.scene]=result;
  for(const list of Object.values(members))for(const id of list)baked[id]={empty:true};
  return {baked,byScene};
}
/**
 * 按图层缓存的逐层烘焙：每层的缓存键是它求值后的内容（含上级图层、被引用的图层、图层编辑与取景尺寸），
 * 修改某项设置后只有内容变化的图层需要重新渲染。返回命中的结果与缺少图层的渲染任务。
 */
async function cachedGroup(theme,draft,device,group) {
  const [sceneWidth,sceneHeight]=(await inspect(theme)).sourceSize;
  const framing=frameScene(sceneWidth,sceneHeight,device.width,device.height,draft.layout,draft.motion.amount,draft.motion.vertical);
  const full={width:Math.ceil(sceneWidth*framing.scale),height:Math.ceil(sceneHeight*framing.scale)};
  const patch=await livePatch(theme,draft);patch.transparent=true;
  const stat=await fs.stat(theme.source);
  const objects=new Map((group.resolved?.objects||[]).map(object=>[object.id,object]));
  const chain=id=>{const list=[];for(let object=objects.get(id);object&&list.length<32;object=objects.get(object.parent))list.push(object);return list;};
  // 效果引用的其他图层画面（_rt_imageLayerComposite_<编号>）也决定这一层的内容。
  const sources=ids=>{const found=new Set(),pending=[...ids];while(pending.length){const id=pending.pop();if(found.has(id)||!objects.has(id))continue;found.add(id);for(const match of JSON.stringify(objects.get(id).effects||[]).matchAll(/_rt_imageLayerComposite_(\d+)_/g))pending.push(Number(match[1]));}return [...found];};
  const bakes=path.join(app.getPath('userData'),'cache','bakes');
  const dirs={},result={},missing=[];
  for(const id of group.targets){
    // 没有求值结果的场景（无脚本信息）退回按整套设置区分。
    const together=[id,...(group.members[id]||[])];
    const content=objects.size?sources(together).map(chain):draft.properties;
    dirs[id]=path.join(bakes,createHash('sha256').update(JSON.stringify([theme.id,stat.mtimeMs,stat.size,full,BAKE,group.minute,content,together.map(member=>patch.layers[member]),patch.fonts])).digest('hex').slice(0,24));
    try{result[id]=JSON.parse(await fs.readFile(path.join(dirs[id],'baked.json'),'utf8'));await fs.utimes(dirs[id],new Date(),new Date());}
    catch{missing.push(id);}
  }
  const fade=Math.round(BAKE.fade*BAKE.fps);
  const job={theme:liveTheme(theme),properties:draft.properties,patch,playing:true,dpr:1,mode:'bake',targets:missing,particles:missing.filter(id=>group.particles.has(id)),members:group.members,minute:group.minute,
    fps:BAKE.fps,frames:Math.round(BAKE.seconds*BAKE.fps)+fade,fade,warmup:Math.round(BAKE.warmup*BAKE.fps),sceneWidth,sceneHeight,full,
    crop:{x:0,y:0,width:full.width,height:full.height}};
  return {group,dirs,result,missing,job};
}
/** 原始帧较大，按最近使用保留约 1.5 GB；current 为本次用到的目录 */
async function pruneBakes(current) {
  const bakes=path.join(app.getPath('userData'),'cache','bakes');
  const entries=await Promise.all((await fs.readdir(bakes)).map(async name=>{
    const folder=path.join(bakes,name);
    // 早期按整组保存的缓存（没有 baked.json）直接清除。
    const legacy=!(await fs.access(path.join(folder,'baked.json')).then(()=>true,()=>false));
    const size=await fs.stat(path.join(folder,'frames.rgba.gz')).then(info=>info.size,()=>0);
    return {folder,time:legacy?0:(await fs.stat(folder)).mtimeMs,size:legacy?Infinity:size};
  }));
  let kept=0;
  for(const entry of entries.sort((a,b)=>b.time-a.time)){kept+=entry.size;if(kept>1.5e9&&!current.has(entry.folder))await fs.rm(entry.folder,{recursive:true,force:true});}
}
async function recordApplication(input,signal,progress) {
  const {theme,draft,device}=input;
  if(!fullAvailable(theme))throw new Error('应用壁纸需要在 Windows 上运行后录制。');
  const settings=exportSettings(draft);
  const framing=frameScene(16,9,device.width,device.height,{scale:1,x:.5,y:.5},draft.motion.amount,draft.motion.vertical);
  const size=recordSize(device.width,device.height,framing);
  const before=new Set((await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:0,height:0}})).map(source=>source.id));
  progress({phase:'启动应用壁纸',progress:5});
  const child=spawn(theme.source,[],{cwd:theme.folder,detached:process.platform!=='win32',stdio:'ignore',windowsHide:false});
  processes.add(child);
  let exited=false;child.on('exit',()=>{exited=true;processes.delete(child);});child.on('error',()=>{exited=true;});
  try{
    let source;
    for(const started=Date.now();!source;){
      if(signal?.aborted)throw new Error('已取消');
      if(exited)throw new Error('应用壁纸启动后立即退出。');
      if(Date.now()-started>30000)throw new Error('等待应用壁纸窗口超时。');
      await new Promise(resolve=>setTimeout(resolve,500));
      source=(await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:0,height:0}})).find(item=>!before.has(item.id)&&item.name);
    }
    const fade=settings.loop?Math.round(settings.fade*settings.fps):0;
    const job={theme:liveTheme(theme),properties:{},patch:{hidden:[],layers:{},fonts:{}},playing:true,dpr:1,mode:'capture',sourceId:source.id,
      layout:draft.layout,margin:{x:framing.marginX,y:framing.marginY},fps:settings.fps,frames:Math.round(settings.duration*settings.fps)+fade,fade,
      warmup:Math.round(3*settings.fps),sceneWidth:16,sceneHeight:9,full:size,crop:{...size,x:0,y:0}};
    ffmpegPath ||= (await worker({operation:'ffmpeg'})).path;
    const output=path.join(app.getPath('userData'),'jobs','record-'+randomUUID()+'.mp4');
    return await record({job,output,ffmpeg:ffmpegPath,rendererUrl:rendererUrl(),signal,
      onProgress:share=>progress({phase:'录制应用画面',progress:Math.round(8+share*72)})});
  }finally{stopWorker(child);}
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
  timeCache.clear();
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
    if(input.mode==='record'){
      const recording=await recordTheme(input,signal,progress);
      try{return await worker({...input,operation:'export',recording},signal,event=>progress({...event,progress:Math.max(82,event.progress)}));}
      finally{await fs.rm(recording.path,{force:true});}
    }
    const theme=await withScripts(input.theme,input.draft,signal);
    if(theme.type!=='scene')return worker({ ...input,theme,operation:'export' },signal,progress);
    progress({phase:'分析时段变化',progress:4});
    const variants=await timeVariantsFor(theme,input.draft,signal);
    const timed=variants&&Object.keys(variants.objects).length?variants:null;
    const {baked,byScene}=await bakeLayers(theme,input.draft,input.device,signal,share=>progress({phase:'逐层渲染特效',progress:Math.round(5+share*45)}),timed)
      .catch(error=>{if(signal.aborted)throw error;throw new Error('逐层渲染未完成：'+error.message+'。可在编辑器“导出”中改用录制模式。');});
    return worker({ ...input,theme,baked,...(timed?{timeVariants:withBaked(timed,byScene)}:{}),operation:'export' },signal,event=>progress({...event,progress:Math.max(52,event.progress)}));
  });
  queue.on('change',snapshot => notify('queue-change',snapshot));
  installRecorderHandlers();
  protocol.handle('yingchuang',async request => {
    const url = new URL(request.url);
    const pieces = url.pathname.slice(1).split('/');
    let root;
    if (url.host==='live') {
      // live/app 只提供渲染页及其打包资源；live/r 为已登记的主题与引擎目录。
      const kind=pieces.shift();
      if (kind==='app'&&(pieces.join('/')==='renderer.html'||pieces[0]==='assets')) root=path.join(__dirname,'../dist');
      else if (kind==='r') root=registeredRoots.get(pieces.shift());
    } else root = registeredRoots.get(pieces.shift());
    if (!root) return new Response('Not found',{status:404});
    const relative = pieces.map(x=>decodeURIComponent(x)).join('/');
    const target = path.resolve(root,relative);
    if (target!==root && !target.startsWith(root+path.sep)) return new Response('Not found',{status:404});
    try {
      const real = await fs.realpath(target);
      const realRoot = await fs.realpath(root);
      if (real!==realRoot && !real.startsWith(realRoot+path.sep)) return new Response('Not found',{status:404});
      const range=request.headers.get('range');
      const response=await net.fetch(pathToFileURL(real).href,range?{headers:{range}}:undefined);
      if(url.host!=='asset')return response;
      // 主界面试听音乐需要对资源做频谱分析，只读的资源地址允许跨来源读取。
      const headers=new Headers(response.headers);headers.set('Access-Control-Allow-Origin','*');
      return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
    } catch { return new Response('Not found',{status:404}); }
  });

  handle('bootstrap',async() => library.themes.length ? state() : scan());
  handle('refresh',scan);
  handle('detail',async id => {
    const theme=themeById(id);
    const {scriptInput:input,...detail}=await inspect(theme);
    return { theme:publicTheme(theme), properties:theme.properties, detail, draft:await draftFor(theme),
      live:{theme:liveTheme(theme),renderer:rendererUrl(),available:fullAvailable(theme),sceneSize:theme.type==='scene'&&detail.sourceSize||[1920,1080]} };
  });
  handle('live-patch',async(id,draft)=>livePatch(themeById(id),draft));
  handle('fonts',() => systemFonts ||= worker({operation:'fonts'}));
  handle('save-draft',(id,draft) => {
    themeById(id);
    store.update(data=> { data.drafts[id]={...structuredClone(draft),layout:cleanLayout(draft.layout)}; });
    return store.data.drafts[id];
  });
  handle('preview',async(id,draft,requestId) => {
    previewController?.abort(); pendingMotion=null;previewController=new AbortController();
    const controller=previewController;
    // 同一主题的悬停预取还在进行时等它写完缓存，不再并行计算一遍。
    if(prefetching?.id===id)await prefetching.done;
    const theme=await withScripts(themeById(id),draft,controller.signal);
    const data=await worker({operation:'preview',theme,draft,device:deviceById(draft.deviceId)},controller.signal,
      event=>notify('preview-progress',{id,...event}));
    if(controller.signal.aborted)throw new Error('已取消');
    if(data.progressive)pendingMotion={id,requestId,theme,draft,controller};
    return previewData(data);
  });
  handle('preview-motion',(id,requestId)=>{
    const pending=pendingMotion;
    if(!pending||pending.id!==id||pending.requestId!==requestId||pending.controller.signal.aborted)return;
    pendingMotion=null;
    const {theme,draft,controller}=pending,device=deviceById(draft.deviceId);
    const live=()=>previewController===controller&&!controller.signal.aborted;
    void (async()=>{
      // 先逐层渲染特效，再生成带逐层视差的完整预览；渲染失败时保留原生近似效果并说明原因。
      const notes=[];let baked={},byScene={},timed=null;
      if(theme.type==='scene'){
        const variants=await timeVariantsFor(theme,draft,controller.signal).catch(error=>{if(!controller.signal.aborted)notes.push('时段变化分析未完成：'+error.message);return null;});
        if(variants?.notes.length)notes.push(...variants.notes);
        timed=variants&&Object.keys(variants.objects).length?variants:null;
        ({baked,byScene}=await bakeLayers(theme,draft,device,controller.signal,share=>{if(live())notify('preview-progress',{id,requestId,phase:`逐层渲染特效 ${Math.round(share*100)}%`,progress:share});},timed)
          .catch(error=>{if(!controller.signal.aborted)notes.push('逐层渲染未完成：'+error.message);return {baked:{},byScene:{}};}));
      }
      const complete=await worker({operation:'motion-preview',theme,draft,device,baked,...(timed?{timeVariants:withBaked(timed,byScene)}:{})},controller.signal,event=>{if(live())notify('preview-progress',{id,requestId,...event});});
      if(live())notify('preview-ready',{id,requestId,data:previewData({...complete,notes:[...notes,...complete.notes]})});
    })().catch(error=>{if(live())notify('preview-ready',{id,requestId,error:error.message});});
  });
  handle('cancel-preview',()=>{pendingMotion=null;previewController?.abort();});
  // 悬停卡片时预先解析主题并生成快速预览写入缓存，点开编辑器时直接命中；新的悬停会取消上一个。
  handle('prefetch',id=>{
    prefetching?.controller.abort();
    const controller=new AbortController(),theme=themeById(id);
    const done=(async()=>{
      const draft=await draftFor(theme);
      if(controller.signal.aborted||!(await inspect(theme)).renderable)return;
      await worker({operation:'preview',theme:await withScripts(theme,draft,controller.signal),draft,device:deviceById(draft.deviceId)},controller.signal);
    })().catch(()=>{});
    prefetching={id,controller,done};
    return done;
  });
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
    if (input.appearance&&typeof input.appearance==='object') data.settings.appearance=cleanAppearance(input.appearance);
  }) && state());
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
      filters:kind==='font'?[{name:'字体',extensions:['ttf','otf','ttc']}]:kind==='audio-preview'?[{name:'音频',extensions:['mp3','wav','ogg','m4a','flac','aac']}]:[{name:'所有文件',extensions:['*']}]});
    if(selection.canceled)return null;
    return kind==='audio-preview'?fileUrl(selection.filePaths[0]):selection.filePaths[0];
  });
  handle('enqueue',async({ids,templateId,deviceId})=>{
    const template=store.snapshot().templates.find(x=>x.id===templateId);
    const inputs=[];
    for (const id of [...new Set(ids)]) {
      const theme=themeById(id);let draft=await draftFor(theme);
      if (template) draft=applyTemplate(draft,template);
      draft=await ensureClockFont(theme,draft);
      if (deviceId) draft.deviceId=deviceById(deviceId).id;
      inputs.push({theme,draft,device:deviceById(draft.deviceId),outputDirectory:store.data.settings.outputDirectory,mode:await exportMode(theme,draft)});
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
  const area=screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({ width:Math.min(1440,area.width),height:Math.min(960,area.height),minWidth:Math.min(800,area.width),minHeight:Math.min(540,area.height),show:false,frame:false,
    backgroundColor:darkStart()?'#0b0f16':'#e8edf4',title:'映窗',icon:path.join(__dirname,'../build/icon.png'),
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
  fillSpares();
  if (process.env.YINGCHUANG_SMOKE_EXIT) setTimeout(()=>app.quit(),Number(process.env.YINGCHUANG_SMOKE_EXIT));
}
if(app.requestSingleInstanceLock())app.whenReady().then(setup).catch(error=>{console.error(error);app.quit();});
else app.quit();
app.on('second-instance',()=>{if(window){if(window.isMinimized())window.restore();window.focus();}});
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
  if(quitReady)return;
  event.preventDefault();
  if(shuttingDown)return;
  shuttingDown=true;pendingMotion=null;
  previewController?.abort();queue?.cancel();
  for (const child of spareWorkers.splice(0)) stopWorker(child);
  for (const child of processes) stopWorker(child);
  void Promise.allSettled([...activeTasks]).then(()=>{quitReady=true;app.quit();});
});
