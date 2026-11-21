const fs = require('node:fs/promises');
const devices = require('./devices.json');
const { fullAvailable } = require('./library.cjs');

function deviceById(id) { return devices.find(item=>item.id===id)||devices[devices.length-1]; }

function createState({app,store,library,queue,builds}) {
  return ()=>({ ...store.snapshot(), themes:library.current.themes.map(library.publicTheme), roots:library.current.roots,
    devices, queue:queue.snapshot(), builds:builds.snapshot(), platform:process.platform, version:app.getVersion() });
}

function cleanAppearance(input) {
  return { material:input.material==='frosted'?'frosted':'liquid', scheme:['light','dark'].includes(input.scheme)?input.scheme:'system',
    ambient:input.ambient!==false, density:input.density==='compact'?'compact':'comfortable' };
}

function installIpc({ipcMain,getWindow,dialog,shell,store,library,projects,resources,workers,pipeline,previews,builds,queue,state,currentDevice}) {
  const handlers=new Map();
  const {themeById,publicTheme,liveTheme}=library;
  const {runWorker}=workers;
  const {fileUrl,rendererUrl}=resources;
  const {inspect,livePatch,exportMode}=pipeline;

  function handle(name,callback) {
    handlers.set(name,callback);
    ipcMain.handle(name,async(event,...args)=>{
      const window=getWindow();
      if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('请求来源无效。');
      const result=await callback(...args);
      if(process.env.YINGCHUANG_DIAGNOSTICS&&name==='bootstrap')console.log('桌面界面已连接：'+result.themes.length+' 张壁纸');
      return result;
    });
  }

  async function scan() { await library.scan();return state(); }

  handle('bootstrap',()=>library.scanned?state():scan());
  handle('refresh',scan);
  handle('detail',async id=>{
    const theme=themeById(id);
    if(theme.preset?.missing)throw new Error(theme.reason);
    const {scriptInput,...detail}=await inspect(theme);
    return {theme:publicTheme(theme),properties:theme.properties,detail,project:await projects.forTheme(theme),
      live:{theme:liveTheme(theme),renderer:rendererUrl(),available:fullAvailable(theme),sceneSize:theme.type==='scene'&&detail.sourceSize||[1920,1080]}};
  });
  handle('fonts',()=>projects.fonts());
  handle('save-project',(id,project)=>projects.save(themeById(id),project));
  handle('live-patch',(id,project)=>livePatch(themeById(id),project,currentDevice()));
  handle('preview',(id,project,requestId)=>previews.preview(themeById(id),project,requestId));
  handle('preview-motion',previews.motion);
  handle('cancel-preview',previews.cancel);
  handle('clock',(id,project)=>previews.clock(themeById(id),project));
  handle('prefetch',id=>previews.prefetch(themeById(id)));
  handle('layer-thumbnails',async id=>{
    const theme=themeById(id);
    const {thumbnails}=await runWorker({operation:'layer-thumbnails',theme,project:await projects.forTheme(theme)});
    return Object.fromEntries(Object.entries(thumbnails).map(([layer,file])=>[layer,fileUrl(file)]));
  });
  handle('favorite',id=>store.update(data=>{
    themeById(id);data.favorites=data.favorites.includes(id)?data.favorites.filter(item=>item!==id):[...data.favorites,id];
  }));
  handle('save-template',(name,project)=>projects.saveTemplate(name,project));
  handle('rename-template',(id,name)=>projects.renameTemplate(id,name));
  handle('delete-template',id=>projects.deleteTemplate(id));
  handle('apply-template',async(ids,id)=>{await projects.applyTemplate(ids.map(themeById),id);return state();});
  handle('settings',input=>{
    store.update(data=>{
      if(typeof input.deviceId==='string')data.settings.deviceId=deviceById(input.deviceId).id;
      if(typeof input.outputDirectory==='string')data.settings.outputDirectory=input.outputDirectory;
      if(input.appearance&&typeof input.appearance==='object')data.settings.appearance=cleanAppearance(input.appearance);
      if(input.timeVariationNotice===true)data.settings.timeVariationNotice=true;
    });
    return state();
  });
  handle('choose-directory',async purpose=>{
    const selection=await dialog.showOpenDialog(getWindow(),{title:purpose==='output'?'选择导出位置':'添加壁纸目录',properties:['openDirectory','createDirectory']});
    if(selection.canceled)return null;
    const folder=selection.filePaths[0];
    store.update(data=>{
      if(purpose==='output')data.settings.outputDirectory=folder;
      else if(!data.settings.roots.includes(folder))data.settings.roots.push(folder);
    });
    return purpose==='output'?state():scan();
  });
  handle('remove-directory',folder=>{store.update(data=>{data.settings.roots=data.settings.roots.filter(item=>item!==folder);});return scan();});
  handle('choose-file',async kind=>{
    const selection=await dialog.showOpenDialog(getWindow(),{title:kind==='font'?'选择字体':kind==='directory'?'选择目录':'选择文件',properties:[kind==='directory'?'openDirectory':'openFile'],
      filters:kind==='font'?[{name:'字体',extensions:['ttf','otf','ttc']}]:kind==='audio-preview'?[{name:'音频',extensions:['mp3','wav','ogg','m4a','flac','aac']}]:[{name:'所有文件',extensions:['*']}]});
    if(selection.canceled)return null;
    return kind==='audio-preview'?fileUrl(selection.filePaths[0]):selection.filePaths[0];
  });
  handle('enqueue',async({ids})=>{
    const device=currentDevice(),{outputDirectory}=store.data.settings,inputs=[];
    for(const id of new Set(ids)){
      const theme=themeById(id);
      if(!theme.available)throw new Error(theme.reason);
      const project=await projects.ensureClockFont(theme,await projects.forTheme(theme));
      inputs.push({theme,project,device,outputDirectory,mode:await exportMode(theme,project)});
    }
    return queue.add(inputs);
  });
  handle('cancel-queue',id=>{queue.cancel(id);return queue.snapshot();});
  handle('clear-queue',()=>{queue.clear();return queue.snapshot();});
  handle('show-build',id=>shell.showItemInFolder(builds.byId(id).file));
  handle('open-output',async()=>{
    const folder=store.data.settings.outputDirectory;
    await fs.mkdir(folder,{recursive:true});await shell.openPath(folder);
  });
  handle('build-report',id=>builds.report(id));
  handle('build-preview',id=>builds.preview(id));
  handle('remove-build',id=>builds.remove(id));
  handle('open-theme',async id=>{await shell.openPath(themeById(id).ownFolder);});
  handle('open-workshop',id=>shell.openExternal('steam://url/CommunityFilePage/'+id));
  handle('window-control',action=>{
    const window=getWindow();
    if(action==='minimize')window.minimize();
    if(action==='maximize')window.isMaximized()?window.unmaximize():window.maximize();
    if(action==='close')window.close();
  });
  return {handlers,handle};
}

module.exports = { createState, installIpc, deviceById };
