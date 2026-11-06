const { contextBridge, ipcRenderer } = require('electron');
const invoke = (name,...args) => ipcRenderer.invoke(name,...args);
const listen = (name,callback) => {
  const listener=(_event,value)=>callback(value);
  ipcRenderer.on(name,listener);return ()=>ipcRenderer.removeListener(name,listener);
};
contextBridge.exposeInMainWorld('yingchuang',{
  bootstrap:()=>invoke('bootstrap'),refresh:()=>invoke('refresh'),detail:id=>invoke('detail',id),fonts:()=>invoke('fonts'),
  saveDraft:(id,draft)=>invoke('save-draft',id,draft),preview:(id,draft)=>invoke('preview',id,draft),
  clock:(id,draft)=>invoke('clock',id,draft),cancelPreview:()=>invoke('cancel-preview'),
  favorite:id=>invoke('favorite',id),saveTemplate:(name,layout)=>invoke('save-template',name,layout),
  deleteTemplate:id=>invoke('delete-template',id),applyTemplate:(ids,id)=>invoke('apply-template',ids,id),
  settings:settings=>invoke('settings',settings),chooseDirectory:purpose=>invoke('choose-directory',purpose),
  removeDirectory:folder=>invoke('remove-directory',folder),chooseFile:kind=>invoke('choose-file',kind),
  enqueue:input=>invoke('enqueue',input),cancelQueue:id=>invoke('cancel-queue',id),clearQueue:()=>invoke('clear-queue'),
  openTheme:id=>invoke('open-theme',id),openOutput:id=>invoke('open-output',id),windowControl:action=>invoke('window-control',action),
  onQueue:callback=>listen('queue-change',callback),onPreviewProgress:callback=>listen('preview-progress',callback),
});
