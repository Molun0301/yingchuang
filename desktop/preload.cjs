const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name,...args) => ipcRenderer.invoke(name,...args);
const listen = (name,callback) => {
  const listener=(_event,value)=>callback(value);
  ipcRenderer.on(name,listener);return ()=>ipcRenderer.removeListener(name,listener);
};
// 界面可用的全部接口；参数与返回值见 src/types.ts 的 Bridge，约定见 docs/开发文档/32数据模型与接口/接口约定.md。
contextBridge.exposeInMainWorld('yingchuang',{
  bootstrap:()=>invoke('bootstrap'),refresh:()=>invoke('refresh'),onLibrary:callback=>listen('library-change',callback),
  detail:id=>invoke('detail',id),fonts:()=>invoke('fonts'),
  saveProject:(id,project)=>invoke('save-project',id,project),livePatch:(id,project)=>invoke('live-patch',id,project),
  preview:(id,project,requestId)=>invoke('preview',id,project,requestId),previewMotion:(id,requestId)=>invoke('preview-motion',id,requestId),
  cancelPreview:()=>invoke('cancel-preview'),clock:(id,project)=>invoke('clock',id,project),prefetch:id=>invoke('prefetch',id),
  layerThumbnails:id=>invoke('layer-thumbnails',id),
  favorite:id=>invoke('favorite',id),saveTemplate:(name,project)=>invoke('save-template',name,project),
  renameTemplate:(id,name)=>invoke('rename-template',id,name),deleteTemplate:id=>invoke('delete-template',id),applyTemplate:(ids,id)=>invoke('apply-template',ids,id),
  settings:settings=>invoke('settings',settings),chooseDirectory:purpose=>invoke('choose-directory',purpose),
  removeDirectory:folder=>invoke('remove-directory',folder),chooseFile:kind=>invoke('choose-file',kind),
  enqueue:input=>invoke('enqueue',input),cancelQueue:id=>invoke('cancel-queue',id),clearQueue:()=>invoke('clear-queue'),
  onQueue:callback=>listen('queue-change',callback),onBuilds:callback=>listen('builds-change',callback),
  showBuild:id=>invoke('show-build',id),openOutput:()=>invoke('open-output'),buildReport:id=>invoke('build-report',id),buildPreview:id=>invoke('build-preview',id),removeBuild:id=>invoke('remove-build',id),
  openTheme:id=>invoke('open-theme',id),openWorkshop:workshopId=>invoke('open-workshop',workshopId),windowControl:action=>invoke('window-control',action),
  onPreviewProgress:callback=>listen('preview-progress',callback),onPreviewReady:callback=>listen('preview-ready',callback),
  updateCheck:()=>invoke('update-check'),updateChangelog:()=>invoke('update-changelog'),updateDownload:()=>invoke('update-download'),updateCancel:()=>invoke('update-cancel'),
  updateInstall:()=>invoke('update-install'),updateSettings:patch=>invoke('update-settings',patch),openRelease:url=>invoke('open-release',url),
  onUpdate:callback=>listen('update',callback),
});
