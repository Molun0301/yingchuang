const { app, net, shell } = require('electron');
const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');

const RELEASES = 'https://api.github.com/repos/Molun0301/yingchuang/releases/latest';
const RELEASE_PAGE = 'https://github.com/Molun0301/yingchuang/releases/latest';
const run = promisify(execFile);

// 先比较主版本，再按语义化版本规则比较预发布标识；构建标识不参与排序。
function compareVersions(left, right) {
  const parts = value => value.replace(/^v/, '').split('+')[0].split(/-(.*)/s);
  const [a, apre] = parts(left), [b, bpre] = parts(right);
  const av = a.split('.').map(Number), bv = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (av[i] !== bv[i]) return av[i] > bv[i] ? 1 : -1;
  if (apre === bpre) return 0;
  if (apre === undefined || bpre === undefined) return apre === undefined ? 1 : -1;
  const aa = apre.split('.'), bb = bpre.split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === bb[i]) continue;
    if (aa[i] === undefined || bb[i] === undefined) return aa[i] === undefined ? -1 : 1;
    const an = /^\d+$/.test(aa[i]), bn = /^\d+$/.test(bb[i]);
    if (an && bn) return Number(aa[i]) > Number(bb[i]) ? 1 : -1;
    if (an !== bn) return an ? -1 : 1;
    return aa[i] > bb[i] ? 1 : -1;
  }
  return 0;
}

function windowsScript({ pid, source, target }) {
  // 批处理中的百分号需要转义；禁用延迟展开以保留路径中的感叹号。
  const quote = value => `"${value.replace(/%/g, '%%')}"`;
  return [
    '@echo off', 'chcp 65001 >nul', 'setlocal DisableDelayedExpansion', ':wait',
    `tasklist /FI "PID eq ${pid}" /NH 2>nul | findstr /R /C:"[ ]${pid}[ ]" >nul`,
    'if not errorlevel 1 (', '  ping -n 2 127.0.0.1 >nul', '  goto wait', ')',
    `robocopy ${quote(source)} ${quote(target)} /E /R:0 /W:0`,
    'if errorlevel 8 exit /b', `rmdir /S /Q ${quote(source)}`,
    `start "" /D ${quote(target)} ${quote(path.win32.join(target, '映窗.exe'))}`,
    'del "%~f0"', '',
  ].join('\r\n');
}

function installUpdater({ store, handle, notify }) {
  const current = process.env.YINGCHUANG_UPDATE_CURRENT || app.getVersion();
  const directory = path.join(app.getPath('userData'), 'updates');
  const canInstall = process.platform === 'win32' || (process.platform === 'linux' && Boolean(process.env.APPIMAGE));
  let release, downloaded, controller;
  const settings = () => ({ auto: true, skipVersion: '', lastCheck: 0, ...store.data.settings.update });
  const saveSettings = patch => { store.update(data => { data.settings.update = { ...settings(), ...patch }; }); };
  const send = event => notify('update', event);
  const status = () => ({ current, canInstall, settings: settings() });

  async function check() {
    const response = await net.fetch(RELEASES, { headers: { 'User-Agent': `yingchuang/${current}`, Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error('检查更新失败，请稍后重试。');
    const data = await response.json();
    const latest = data.tag_name.replace(/^v/, '');
    const suffix = process.platform === 'win32' ? '-Windows-x64.zip' : process.platform === 'linux' ? `-Linux-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.AppImage` : null;
    const asset = suffix ? data.assets.find(item => item.name.endsWith(suffix)) : null;
    release = { current, latest, available: compareVersions(latest, current) > 0,
      notes: data.body || '', url: data.html_url, publishedAt: data.published_at,
      asset: asset ? { name: asset.name, size: asset.size, digest: asset.digest, url: asset.browser_download_url } : null };
    saveSettings({ lastCheck: Date.now() });
    return release;
  }

  async function download() {
    const selected = release, asset = selected.asset;
    // 缺少摘要时无法确认可执行文件的完整性，不进入安装流程。
    if (!/^sha256:[a-f\d]{64}$/i.test(asset.digest || '')) throw new Error('发布文件缺少 SHA-256 校验信息。');
    const abort = new AbortController(); controller = abort; downloaded = null;
    const temp = path.join(directory, asset.name + '.downloading');
    const file = path.join(directory, asset.name);
    let bytes = 0, lastBytes = 0, lastTime = Date.now(), speed = 0;
    const hash = createHash('sha256');
    const progress = (final = false) => {
      const now = Date.now(), elapsed = now - lastTime;
      if (!final && elapsed < 180) return;
      if (elapsed > 0) speed = (bytes - lastBytes) * 1000 / elapsed;
      lastTime = now; lastBytes = bytes;
      send({ type: 'progress', progress: { downloaded: bytes, total: asset.size, percent: bytes / asset.size * 100, speed } });
    };
    try {
      await fs.mkdir(directory, { recursive: true });
      const response = await net.fetch(asset.url, { signal: abort.signal, headers: { 'User-Agent': `yingchuang/${current}` } });
      if (!response.ok) throw new Error('下载失败，请稍后重试。');
      await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, done) {
        hash.update(chunk); bytes += chunk.length; progress(); done(null, chunk);
      } }), createWriteStream(temp), { signal: abort.signal });
      if (bytes !== asset.size) throw new Error('下载文件大小不符，请重新下载。');
      if (`sha256:${hash.digest('hex')}` !== asset.digest.toLowerCase()) throw new Error('下载文件校验失败，请重新下载。');
      await fs.rename(temp, file);
      progress(true);
      downloaded = { path: file, version: selected.latest, canInstall };
      send({ type: 'downloaded', download: downloaded });
      return downloaded;
    } catch (error) {
      await fs.rm(temp, { force: true });
      if (abort.signal.aborted) { send({ type: 'cancelled' }); return null; }
      throw error;
    } finally { controller = null; }
  }

  async function install() {
    if (!downloaded) throw new Error('请先下载并校验更新。');
    if (process.platform === 'linux' && process.env.APPIMAGE) {
      const target = process.env.APPIMAGE, temp = target + '.updating';
      try {
        await fs.copyFile(downloaded.path, temp);
        await fs.chmod(temp, 0o755);
        await fs.rename(temp, target);
      } catch (error) { await fs.rm(temp, { force: true }); throw error; }
      app.relaunch({ execPath: target }); app.quit();
      return { manual: false };
    }
    if (process.platform === 'win32') {
      const target = path.dirname(process.execPath);
      const probe = path.join(target, `.yingchuang-update-${process.pid}.tmp`);
      try { await fs.writeFile(probe, ''); await fs.rm(probe); }
      catch { shell.showItemInFolder(downloaded.path); return { manual: true, message: '程序目录不可写，请解压下载文件并手动替换。' }; }
      const source = await fs.mkdtemp(path.join(directory, 'unpack-'));
      try {
        await run(path.win32.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', downloaded.path, '-C', source], { windowsHide: true });
        const script = path.join(directory, 'install.cmd');
        await fs.writeFile(script, windowsScript({ pid: process.pid, source, target }), 'utf8');
        const child = spawn(process.env.ComSpec, ['/d', '/s', '/c', `""${script}""`], { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
        child.unref(); app.quit();
        return { manual: false };
      } catch (error) { await fs.rm(source, { recursive: true, force: true }); throw error; }
    }
    shell.showItemInFolder(downloaded.path);
    return { manual: true, message: '已打开下载位置，请手动替换应用文件。' };
  }

  handle('update-check', check);
  handle('update-download', download);
  handle('update-cancel', () => { controller?.abort(); });
  handle('update-install', install);
  handle('update-settings', patch => {
    if (patch) saveSettings(patch);
    return status();
  });
  handle('open-release', url => {
    const target = url || RELEASE_PAGE;
    if (!target.startsWith('https://github.com/')) throw new Error('仅支持打开 GitHub 发布页。');
    return shell.openExternal(target);
  });
  const timer = setTimeout(async () => {
    if (!settings().auto || Date.now() - settings().lastCheck < 6 * 60 * 60 * 1000) return;
    try {
      const result = await check();
      if (result.available && result.latest !== settings().skipVersion) send({ type: 'available', release: result });
    } catch { send({ type: 'error', message: '自动检查更新失败，可在设置中重新检查。' }); }
  }, 5000);
  app.once('before-quit', () => { clearTimeout(timer); controller?.abort(); });
}

module.exports = { installUpdater, compareVersions, windowsScript };
