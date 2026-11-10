// 隐藏窗口录制完整画面：场景逐帧确定性出图，网页按实时画面采集；首尾交叉淡化后编码为循环视频。
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { createGzip, constants: zlib } = require('node:zlib');
const path = require('node:path');

// 正在进行的录制或烘焙窗口，按窗口区分；逐层烘焙会同时开多个窗口。
const active = new Map();

function installRecorderHandlers() {
  const current = event => {
    const task = active.get(event.sender.id);
    if (!task) throw new Error('录制任务已结束');
    return task;
  };
  ipcMain.handle('recorder-job', event => current(event).job);
  ipcMain.handle('recorder-frame', (event, data) => current(event).frame(data));
  ipcMain.handle('recorder-ready', event => current(event).ready());
  ipcMain.handle('recorder-fail', (event, message) => current(event).fail(new Error(String(message))));
  ipcMain.handle('recorder-layer', (event, meta) => current(event).layer(meta));
  ipcMain.handle('recorder-done', event => current(event).done());
}

let encoderChoice;
function selectEncoder(ffmpeg) {
  encoderChoice ||= (async () => {
    for (const name of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
      const available = await new Promise(resolve => {
        const probe = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'lavfi', '-i',
          'testsrc=size=320x240:rate=1', '-frames:v', '1', '-an', '-c:v', name, '-pix_fmt', 'yuv420p', '-f', 'null', '-'],
        { windowsHide: true, stdio: 'ignore' });
        probe.on('error', () => resolve(false));
        probe.on('close', code => resolve(code === 0));
      });
      if (available) return name;
    }
    return 'libx264';
  })();
  return encoderChoice;
}

async function encoder(ffmpeg, output, width, height, fps, pixelFormat) {
  const name = await selectEncoder(ffmpeg);
  const quality = {
    libx264: ['-preset', 'medium', '-crf', '18'],
    h264_nvenc: ['-rc', 'vbr', '-cq', '18', '-b:v', '0'],
    h264_qsv: ['-global_quality', '18'],
    h264_amf: ['-rc', 'cqp', '-qp_i', '18', '-qp_p', '18', '-qp_b', '18'],
  }[name];
  const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', pixelFormat,
    '-s', `${width}x${height}`, '-r', String(fps), '-i', 'pipe:0', '-an', '-c:v', name, ...quality,
    '-maxrate', '12M', '-bufsize', '24M', '-pix_fmt', 'yuv420p', '-g', String(fps * 2), '-movflags', '+faststart', output],
  { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
  child.stdin.on('error', () => {});
  const exit = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(new Error('视频编码未完成：' + (errors.trim().split('\n').pop() || code))));
  });
  exit.catch(() => {});
  return {
    exit,
    write: data => new Promise(resolve => { if (child.stdin.write(data)) resolve(); else child.stdin.once('drain', resolve); }),
    finish: () => { child.stdin.end(); return exit; },
    kill: () => { if (child.exitCode === null) child.kill('SIGKILL'); },
  };
}

/** 先缓存开头若干帧；录到末尾时与开头逐帧混合，输出从第 fade 帧开始，循环衔接处没有跳变。 */
class LoopWriter {
  constructor(output, body, fade) { Object.assign(this, { output, body, fade, head: [], index: 0 }); }
  get complete() { return this.index >= this.body + this.fade; }
  push(frame) {
    const index = this.index++;
    if (index < this.fade) { this.head.push(Buffer.from(frame)); return Promise.resolve(); }
    if (index < this.body) return this.output.write(frame);
    const step = index - this.body, weight = (step + 0.5) / this.fade, head = this.head[step];
    const mixed = Buffer.allocUnsafe(frame.length);
    for (let i = 0; i < frame.length; i++) mixed[i] = (frame[i] + (head[i] - frame[i]) * weight + 0.5) | 0;
    this.head[step] = null;
    return this.output.write(mixed);
  }
}

async function record({ job, output, ffmpeg, rendererUrl, signal, onProgress }) {
  if (signal?.aborted) throw new Error('已取消');
  const { width, height } = job.crop;
  const fade = Math.min(job.fade, Math.floor((job.frames - job.fade) / 2));
  const body = job.frames - job.fade;
  await fs.mkdir(path.dirname(output), { recursive: true });
  // realtime 由主进程从离屏窗口取帧（BGRA）；step 与 capture 由页面送出 RGBA 像素。
  const realtime = job.mode === 'realtime';
  const video = await encoder(ffmpeg, output, width, height, job.fps, realtime ? 'bgra' : 'rgba');
  const loop = new LoopWriter(video, body, fade);
  const total = body + fade;
  const window = recorderWindow(job);
  const id = window.webContents.id;
  return new Promise((resolve, reject) => {
    let settled = false, watchdog, sampler, lastReport = 0;
    const alive = () => { clearTimeout(watchdog); watchdog = setTimeout(() => finish(new Error('录制超时：壁纸长时间没有输出画面')), 90000); };
    const finish = async error => {
      if (settled) return;
      settled = true; active.delete(id);
      clearTimeout(watchdog); clearInterval(sampler); signal?.removeEventListener('abort', abort);
      if (!window.isDestroyed()) window.destroy();
      if (error) { video.kill(); await video.exit.catch(() => {}); await fs.rm(output, { force: true }); reject(error); return; }
      try { await video.finish(); resolve({ path: output, width, height, fps: job.fps, duration: body / job.fps, fade: fade / job.fps }); }
      catch (failure) { reject(failure); }
    };
    const abort = () => finish(new Error('已取消'));
    const accept = async frame => {
      alive();
      await loop.push(frame);
      const now = Date.now();
      if (now - lastReport > 250 || loop.complete) { lastReport = now; onProgress(loop.index / total); }
      if (loop.complete) await finish();
    };
    signal?.addEventListener('abort', abort, { once: true });
    alive();
    active.set(id, {
      window, job,
      frame: data => settled ? undefined : accept(Buffer.from(data.buffer, data.byteOffset, data.byteLength)),
      fail: error => finish(error),
      ready: () => {
        // 网页壁纸先运行片刻再开始采集；按固定节拍取最近一帧，画面静止时重复上一帧。
        let latest = null, busy = false;
        window.webContents.on('paint', (_event, _dirty, image) => { latest = image; });
        window.webContents.setFrameRate(job.fps);
        window.webContents.invalidate();
        setTimeout(() => {
          if (settled) return;
          sampler = setInterval(() => {
            if (busy || !latest || settled) return;
            busy = true;
            const size = latest.getSize();
            const image = size.width === width && size.height === height ? latest : latest.resize({ width, height });
            accept(image.toBitmap()).catch(finish).finally(() => { busy = false; });
          }, 1000 / job.fps);
        }, Math.max(1500, job.warmup * 1000 / job.fps));
      },
    });
    window.webContents.on('render-process-gone', (_event, details) => finish(new Error('渲染进程退出：' + details.reason)));
    window.loadURL(rendererUrl + '?mode=record').catch(finish);
  });
}

function recorderWindow(job) {
  const window = new BrowserWindow({ show: false, width: job.crop.width, height: job.crop.height, useContentSize: true, frame: false, paintWhenInitiallyHidden: true,
    webPreferences: { preload: path.join(__dirname, 'recorder-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
      backgroundThrottling: false, offscreen: job.mode === 'realtime', zoomFactor: 1 } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.setAudioMuted(true);
  return window;
}

/**
 * 逐层烘焙：渲染页依次送来每个目标图层的裁切帧，首尾交叉衔接后写成 <root>/<id>/frames.rgba。
 * 返回 Python 需要的 baked 描述；没有画面的图层不写入，交给原生管线处理。
 */
async function bakeWindow({ job, dirs, rendererUrl, signal, onProgress }) {
  if (signal?.aborted) throw new Error('已取消');
  const window = recorderWindow(job), baked = {}, id = window.webContents.id;
  let current = null, finished = 0;
  const close = async () => {
    if (!current) return;
    const { stream, meta } = current;
    current = null;
    const file = stream._readableState.pipes[0];
    await new Promise((resolve, reject) => { file.once('finish', resolve).once('error', reject); stream.end(); });
    baked[meta.id] = { dir: dirs[meta.id], width: meta.width, height: meta.height, count: meta.still ? 1 : meta.count - job.fade, fps: job.fps, bbox: meta.bbox };
  };
  return new Promise((resolve, reject) => {
    let settled = false, watchdog;
    const alive = () => { clearTimeout(watchdog); watchdog = setTimeout(() => finish(new Error('逐层渲染超时：壁纸长时间没有输出画面')), 90000); };
    const finish = async error => {
      if (settled) return;
      settled = true; active.delete(id);
      clearTimeout(watchdog); signal?.removeEventListener('abort', abort);
      if (!window.isDestroyed()) window.destroy();
      if (current) { current.stream.destroy(); current = null; }
      if (error) { await Promise.all(job.targets.map(target => fs.rm(dirs[target], { recursive: true, force: true }))); reject(error); } else resolve(baked);
    };
    const abort = () => finish(new Error('已取消'));
    signal?.addEventListener('abort', abort, { once: true });
    alive();
    active.set(id, {
      window, job,
      layer: async meta => {
        alive();
        await close();
        onProgress(finished++ / job.targets.length);
        // 渲染器里没有画面的图层（被脚本隐藏等）记为空，转换时同样不输出。
        if (!meta.width) { baked[meta.id] = { empty: true }; return; }
        await fs.mkdir(dirs[meta.id], { recursive: true });
        // 透明区域占多数，低压缩级别即可明显缩小缓存，且不拖慢烘焙。
        const stream = createGzip({ level: 1, strategy: zlib.Z_RLE });
        stream.pipe(createWriteStream(path.join(dirs[meta.id], 'frames.rgba.gz')));
        const writer = { write: data => new Promise(done => { if (stream.write(data)) done(); else stream.once('drain', done); }) };
        // 静止图层只有一帧，直接写入，不做首尾衔接。
        current = { stream, meta, loop: meta.still ? { push: data => writer.write(data) } : new LoopWriter(writer, meta.count - job.fade, job.fade) };
      },
      frame: data => { alive(); return current?.loop.push(Buffer.from(data.buffer, data.byteOffset, data.byteLength)); },
      done: async () => { await close(); onProgress(1); await finish(); },
      ready: () => {},
      fail: error => finish(error),
    });
    window.webContents.on('render-process-gone', (_event, details) => finish(new Error('渲染进程退出：' + details.reason)));
    window.loadURL(rendererUrl + '?mode=record').catch(finish);
  });
}

/**
 * 多个烘焙任务（当前时刻与各时段状态）一起并行：每个任务的图层交错切成若干窗口，所有窗口排队共用 windows 个并发名额。
 * 每个窗口只载入自己负责的图层（patch.keep），每帧渲染开销与载入时间随之下降。tasks 为 [{job, dirs}]，返回各任务的 baked。
 */
async function bake({ tasks, rendererUrl, signal, onProgress, windows = 2 }) {
  const total = tasks.reduce((sum, task) => sum + task.job.targets.length, 0);
  const per = Math.max(1, Math.ceil(total / windows));
  const parts = tasks.flatMap(({ job, dirs }, index) => {
    const count = Math.ceil(job.targets.length / per);
    return Array.from({ length: count }, (_, k) => ({ index, job, dirs, targets: job.targets.filter((_, i) => i % count === k) }));
  });
  const shares = parts.map(() => 0), results = tasks.map(() => ({})), controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  let next = 0;
  const run = async () => {
    while (next < parts.length) {
      const k = next++, { index, job, dirs, targets } = parts[k];
      const keep = targets.flatMap(id => [id, ...(job.members?.[id] || [])]);
      Object.assign(results[index], await bakeWindow({ job: { ...job, targets, patch: { ...job.patch, keep } }, dirs, rendererUrl, signal: controller.signal,
        onProgress: share => { shares[k] = share; onProgress(shares.reduce((sum, value, i) => sum + value * parts[i].targets.length, 0) / total); } }));
    }
  };
  try {
    // 一个窗口失败时立即停止其余窗口，不让它们空跑到超时。
    await Promise.all(Array.from({ length: Math.min(windows, parts.length) }, () => run().catch(error => { stop(); throw error; })));
    return results;
  } finally { signal?.removeEventListener('abort', stop); }
}

module.exports = { installRecorderHandlers, record, bake, LoopWriter };
