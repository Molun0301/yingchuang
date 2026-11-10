// 录制窗口只暴露取任务、送帧和报告状态，壁纸脚本拿不到其他系统接口。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('recorder', {
  job: () => ipcRenderer.invoke('recorder-job'),
  frame: data => ipcRenderer.invoke('recorder-frame', data),
  ready: () => ipcRenderer.invoke('recorder-ready'),
  fail: message => ipcRenderer.invoke('recorder-fail', String(message)),
  layer: meta => ipcRenderer.invoke('recorder-layer', meta),
  done: () => ipcRenderer.invoke('recorder-done'),
});
