const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { spawn } = require('node:child_process');

function stopWorker(child) {
  if (!child.pid) return;
  if (process.platform==='win32') { spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>child.kill()); }
  else { try{process.kill(-child.pid,'SIGTERM');}catch{child.kill('SIGTERM');} }
}
function workerMessage(message = '') {
  const file = message.match(/:\s+(['"])(.*?)\1\s*$/)?.[2];
  if (/\[Errno 2\]|FileNotFoundError|\bENOENT\b|\[WinError [23]\]/.test(message))
    return file ? `找不到文件 ${file}，壁纸可能已被移动或删除。` : '找不到所需文件，壁纸可能已被移动或删除。';
  if (/\[Errno (?:1|13)\]|PermissionError|\b(?:EACCES|EPERM)\b|\[WinError 5\]/.test(message))
    return file ? `没有权限读取 ${file}。` : '没有权限访问所需的文件或目录。';
  if (/\[Errno 28\]|\bENOSPC\b|\[WinError 112\]/.test(message)) return '磁盘空间不足，请清理空间后重新导出。';
  if (/JSONDecodeError|UnicodeDecodeError/.test(message)) return '壁纸文件的格式无法读取。';
  if (/^\p{Script=Han}/u.test(message)) return message;
  return message ? '转换未完成：' + message : '转换进程未完成，请检查壁纸文件后重试。';
}

function createWorkers({ core, userData, packaged }) {
  const { lunar } = require(path.join(core,'组件绘制.cjs'));
  const processes = new Set(), activeTasks = new Set();
  let shuttingDown = false;
  function trackProcess(child) {
    processes.add(child);
    child.once('close',()=>processes.delete(child));
  }
  function runWorker(...args) {
    if(shuttingDown)return Promise.reject(new Error('应用正在关闭'));
    const task=execute(...args);activeTasks.add(task);
    task.then(()=>activeTasks.delete(task),()=>activeTasks.delete(task));
    return task;
  }

  /** 启动一个转换进程：模块导入在读取请求之前完成，所以可以提前启动备用 */
  function launchWorker() {
    let command, args;
    if (packaged && process.platform === 'linux') {
      command = path.join(process.resourcesPath,'runtime/converter-worker'); args = [];
    } else {
      const localPython=path.join(__dirname,process.platform==='win32'?'../.venv/Scripts/python.exe':'../.venv/bin/python');
      command = packaged ? path.join(process.resourcesPath,'runtime/python.exe') : (process.env.YINGCHUANG_PYTHON || (existsSync(localPython)?localPython:'python3'));
      args = ['-I','-X','utf8','-u',path.join(core,'应用桥接.py')];
    }
    const child = spawn(command,args,{ windowsHide:true, detached:process.platform!=='win32', stdio:['pipe','pipe','pipe'],
      env:{ ...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1', YINGCHUANG_CORE:core,
        YINGCHUANG_RUNTIME:packaged?path.join(process.resourcesPath,'runtime'):path.join(__dirname,'../runtime',process.platform==='win32'?'win':'linux'),
        IMAGEIO_FFMPEG_EXE:path.join(packaged?path.join(process.resourcesPath,'runtime'):path.join(__dirname,'../runtime',process.platform==='win32'?'win':'linux'),process.platform==='win32'?'ffmpeg.exe':'ffmpeg'),
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

  async function execute(input, signal, onProgress = () => {}) {
    const started=performance.now();
    if (signal?.aborted) throw new Error('已取消');
    const cacheRoot = path.join(userData,'cache');
    const jobsRoot = path.join(userData,'jobs');
    await fs.mkdir(jobsRoot,{recursive:true});
    const scratchRoot = await fs.mkdtemp(path.join(jobsRoot,'job-'));
    let exportStagingRoot, committed=false;
    try {
      if(input.operation==='export'){
        await fs.mkdir(input.outputDirectory,{recursive:true});
        await fs.mkdir(path.dirname(input.buildDirectory),{recursive:true});
        exportStagingRoot=await fs.mkdtemp(path.join(jobsRoot,'export-'));
      }
      if(signal?.aborted)throw new Error('已取消');
      if(shuttingDown)throw new Error('应用正在关闭');
      const output=await new Promise((resolve,reject) => {
        const child = takeWorker();
        trackProcess(child);
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
          signal?.removeEventListener('abort',abort);
          if(input.operation==='export'&&result===undefined){
            try{const committed=JSON.parse(await fs.readFile(path.join(scratchRoot,'job-result.json'),'utf8'));await fs.access(committed.path);result=committed;}catch{}
          }
          if(input.operation==='export'&&result!==undefined)resolve(result);
          else if (signal?.aborted) reject(new Error('已取消'));
          else if (code!==0 || result===undefined) reject(new Error(workerMessage(failure || errors.trim().split('\n').pop())));
          else resolve(result);
        });
        child.stdin.on('error',()=>{});
        child.stdin.end(JSON.stringify({ ...input,...(['preview','motion-preview','clock','export'].includes(input.operation)?{widgetSamples:lunar(new Date())}:{}),cacheRoot,scratchRoot,exportStagingRoot })+'\n');
        if (signal?.aborted) abort();
      });
      committed=input.operation==='export';
      return output;
    } finally {
      await fs.rm(scratchRoot,{recursive:true,force:true});
      if(exportStagingRoot){
        await fs.rm(exportStagingRoot,{recursive:true,force:true,maxRetries:3,retryDelay:100});
        // 强制停止转换进程时，Python 的 finally 可能来不及清理临时包和成品目录。
        await fs.rm(input.outputFile+'.writing',{force:true});
        if(!committed)await fs.rm(input.buildDirectory,{recursive:true,force:true});
      }
      if(process.env.YINGCHUANG_DIAGNOSTICS)console.log('工作进程 '+input.operation+' '+Math.round(performance.now()-started)+' ms');
    }
  }

  function shutdown() {
    shuttingDown=true;
    for (const child of spareWorkers.splice(0)) stopWorker(child);
    for (const child of processes) stopWorker(child);
    return Promise.allSettled([...activeTasks]);
  }
  return { runWorker, stopWorker, trackProcess, fillSpares, shutdown };
}
module.exports = { createWorkers };
