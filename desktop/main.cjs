const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, screen, nativeTheme, desktopCapturer, Notification } = require('electron');
const path = require('node:path');
const { Store } = require('./store.cjs');
const { registerScheme, createResources } = require('./protocol.cjs');
const { createWorkers } = require('./workers.cjs');
const { createLibrary } = require('./library.cjs');
const { Projects } = require('./projects.cjs');
const { createPipeline, createPreview } = require('./pipeline.cjs');
const { Builds } = require('./builds.cjs');
const { ConversionQueue, CONCURRENCY, queueFeedback } = require('./queue.cjs');
const { createState, installIpc, deviceById } = require('./ipc.cjs');
const recorder = require('./recorder.cjs');
const { installUpdater } = require('./updater.cjs');

registerScheme(protocol);
if (process.env.YINGCHUANG_DATA_DIR) app.setPath('userData', process.env.YINGCHUANG_DATA_DIR);
if (process.env.YINGCHUANG_DISABLE_GPU === '1') app.disableHardwareAcceleration();
// 图形进程是单线程的：按垂直同步提交界面画面时，显示器休眠后每次提交会阻塞约 1 秒，隐藏窗口逐层渲染的每次读回都要排队等待。
// 关闭垂直同步后界面仍按显示器刷新率出帧，烘焙不再被阻塞。
app.commandLine.appendSwitch('disable-gpu-vsync');
app.setName('映窗');
let window, stop, browserPreview;
let shuttingDown=false,quitReady=false;

function notify(channel,data) {
  if(window&&!window.isDestroyed())window.webContents.send(channel,data);
  browserPreview?.emit(channel,data);
}

function focusWindow() {
  if(!window||window.isDestroyed())return;
  if(window.isMinimized())window.restore();
  window.focus();
}

async function openWindow(store, dist) {
  // 启动底色与上次的配色一致，避免深色界面打开时闪白。
  const scheme=store.data.settings.appearance?.scheme;
  const dark=scheme==='dark'||(scheme!=='light'&&nativeTheme.shouldUseDarkColors);
  const area=screen.getPrimaryDisplay().workAreaSize;
  window = new BrowserWindow({ width:Math.min(1440,area.width),height:Math.min(960,area.height),minWidth:Math.min(800,area.width),minHeight:Math.min(540,area.height),show:false,frame:false,
    backgroundColor:dark?'#0b0f16':'#e8edf4',title:'映窗',icon:path.join(__dirname,'../build/icon.png'),
    webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true} });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{
    if (url!==window.webContents.getURL()) event.preventDefault();
  });
  window.once('ready-to-show',()=>window.show());
  const dev=process.env.YINGCHUANG_DEV_URL;
  if (dev) await window.loadURL(dev);
  else await window.loadFile(path.join(dist,'index.html'));
}

async function setup() {
  const userData=app.getPath('userData'),dist=path.join(__dirname,'../dist');
  const core=app.isPackaged?path.join(process.resourcesPath,'core'):path.join(__dirname,'../core');
  const store=new Store(userData);
  const resources=createResources(dist);
  const workers=createWorkers({core,userData,packaged:app.isPackaged});
  const currentDevice=()=>deviceById(store.data.settings.deviceId);
  const library=createLibrary({store,resources,onScan:()=>pipeline.clearCaches(),onChange:()=>notify('library-change',state())});
  const pipeline=createPipeline({userData,workers,resources,liveTheme:library.liveTheme,recorder,desktopCapturer,currentDevice});
  const projects=new Projects(store,pipeline.inspect,workers.runWorker);
  const previews=createPreview({pipeline,runWorker:workers.runWorker,projects,currentDevice,notify});
  const builds=new Builds({store,userData,fileUrl:resources.fileUrl,notify:data=>notify('builds-change',data)});
  const queue=new ConversionQueue((input,signal,progress)=>builds.run(input,signal,progress,pipeline.exportWallpaper),CONCURRENCY);
  const state=createState({app,store,library,queue,builds}),getWindow=()=>window;
  queueFeedback({queue,getWindow,notify,Notification,focusWindow});

  const {handlers,handle}=installIpc({ipcMain,getWindow,dialog,shell,store,library,projects,resources,workers,pipeline,previews,builds,queue,state,currentDevice});
  installUpdater({store,handle,notify});
  if(!store.data.settings.outputDirectory){
    store.data.settings.outputDirectory=path.join(app.getPath('documents'),'映窗导出');
    store.save();
  }

  stop=async()=>{
    library.close();previews.close();queue.cancel();
    await Promise.all([workers.shutdown(),queue.whenIdle()]);
  };
  recorder.installRecorderHandlers();
  resources.install(protocol,net);
  await openWindow(store,dist);
  if(!app.isPackaged&&process.env.YINGCHUANG_PREVIEW_PORT){
    browserPreview=require('../scripts/browser-preview.cjs').start({port:Number(process.env.YINGCHUANG_PREVIEW_PORT),handlers,roots:resources.roots,dist});
  }
  workers.fillSpares();
  if(process.env.YINGCHUANG_SMOKE_EXIT)setTimeout(()=>app.quit(),Number(process.env.YINGCHUANG_SMOKE_EXIT));
}

if(app.requestSingleInstanceLock())app.whenReady().then(setup).catch(error=>{console.error(error);app.quit();});
else app.quit();
app.on('second-instance',focusWindow);
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
  if(quitReady)return;
  event.preventDefault();
  if(shuttingDown)return;
  shuttingDown=true;
  void Promise.resolve(stop?.()).finally(()=>{quitReady=true;app.quit();});
});
