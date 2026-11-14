const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

const source = readFileSync(path.join(__dirname, '../desktop/updater.cjs'), 'utf8');
const release = { tag_name: 'v0.3.0', body: '## 本次更新\n- 更新公告与手动下载',
  html_url: 'https://github.com/Molun0301/yingchuang/releases/tag/v0.3.0', published_at: '2026-11-14T00:00:00Z', assets: [] };
const pendingNotes = { version: '0.3.0', notes: '下载时保存的公告', url: release.html_url, publishedAt: release.published_at };

// 直接调用主进程注册的处理函数，保留真实公告判断、缓存写入和下载流程。
function createUpdater({ current = '0.3.0', outputDirectory = '/已有导出目录', update = { seenVersion: '0.2.0' },
  fetch = async () => Response.json(release), directory = '/tmp/映窗公告测试' } = {}) {
  const handlers = {}, requests = [], opened = [], module = { exports: {} };
  const store = { data: { settings: { outputDirectory, update } }, update(callback) { callback(this.data); } };
  const electron = { app: { getVersion: () => current, getPath: () => directory, once() {} },
    net: { fetch: (...args) => { requests.push(args[0]); return fetch(...args); } },
    shell: { openExternal: url => { opened.push(url); } } };
  vm.runInNewContext(source, { module, require: name => name === 'electron' ? electron : require(name),
    process: { env: { YINGCHUANG_UPDATE_CURRENT: current }, platform: process.platform, arch: process.arch },
    setTimeout() {}, clearTimeout() {}, AbortController });
  module.exports.installUpdater({ store, handle: (name, callback) => { handlers[name] = callback; }, notify() {} });
  return { handlers, store, requests, opened, compareVersions: module.exports.compareVersions };
}

test('全新安装只记录当前版本，默认输出目录补齐后也不弹公告', async () => {
  const { handlers, store, requests } = createUpdater({ outputDirectory: '', update: {} });
  assert.equal(store.data.settings.update.seenVersion, '0.3.0');
  store.data.settings.outputDirectory = '/默认导出目录';
  assert.equal(await handlers['update-changelog'](), null);
  assert.equal(requests.length, 0);
});

test('同版本再次启动不弹公告', async () => {
  const { handlers, requests } = createUpdater({ update: { seenVersion: '0.3.0' } });
  assert.equal(await handlers['update-changelog'](), null);
  assert.equal(requests.length, 0);
});

test('版本升级读取对应标签的 GitHub 公告，只返回一次并记住当前版本', async () => {
  const { handlers, store, requests } = createUpdater({ update: { seenVersion: '0.2.0', pendingNotes } });
  const announcement = await handlers['update-changelog']();
  assert.equal(announcement.version, '0.3.0');
  assert.equal(announcement.notes, release.body);
  assert.equal(announcement.url, release.html_url);
  assert.equal(announcement.publishedAt, release.published_at);
  assert.equal(store.data.settings.update.seenVersion, '0.3.0');
  assert.equal(await handlers['update-changelog'](), null);
  assert.deepEqual(requests, ['https://api.github.com/repos/Molun0301/yingchuang/releases/tags/v0.3.0']);
  const restarted = createUpdater({ update: store.data.settings.update });
  assert.equal(await restarted.handlers['update-changelog'](), null);
});

test('已有安装没有版本记录时显示公告，兼容从旧版升级', async () => {
  const { handlers, store } = createUpdater({ update: {} });
  assert.equal((await handlers['update-changelog']()).version, '0.3.0');
  assert.equal(store.data.settings.update.seenVersion, '0.3.0');
});

test('降级启动不弹公告', async () => {
  const { handlers, requests } = createUpdater({ update: { seenVersion: '0.4.0' } });
  assert.equal(await handlers['update-changelog'](), null);
  assert.equal(requests.length, 0);
});

test('版本比较支持主版本、预发布标识与构建标识', () => {
  const { compareVersions } = createUpdater();
  for (const [left, right, expected] of [
    ['0.3.0', '0.2.9', 1], ['0.3.0', '0.3.0', 0], ['0.3.0', '0.4.0', -1],
    ['0.3.0', '0.3.0-rc.1', 1], ['0.3.0-rc.2', '0.3.0-rc.10', -1], ['v0.3.0+build.1', '0.3.0+build.2', 0],
  ]) assert.equal(compareVersions(left, right), expected);
});

test('GitHub 网络失败时使用同版本下载缓存', async () => {
  const { handlers } = createUpdater({ update: { seenVersion: '0.2.0', pendingNotes },
    fetch: async () => { throw new Error('网络不可用'); } });
  assert.equal((await handlers['update-changelog']()).notes, pendingNotes.notes);
});

test('GitHub 未找到版本时使用同版本下载缓存', async () => {
  const { handlers } = createUpdater({ update: { seenVersion: '0.2.0', pendingNotes },
    fetch: async () => new Response('', { status: 404 }) });
  assert.equal((await handlers['update-changelog']()).notes, pendingNotes.notes);
});

test('GitHub 与同版本缓存都没有发布说明时不弹公告', async () => {
  for (const pending of [undefined, { ...pendingNotes, version: '0.4.0' }]) {
    const { handlers } = createUpdater({ update: { seenVersion: '0.2.0', pendingNotes: pending },
      fetch: async () => new Response('', { status: 404 }) });
    assert.equal(await handlers['update-changelog'](), null);
  }
  const empty = createUpdater({ fetch: async () => Response.json({ ...release, body: '' }) });
  assert.equal(await empty.handlers['update-changelog'](), null);
});

test('下载成功后保存该版本公告，重启断网时可以显示', async t => {
  const directory = await fs.mkdtemp('/tmp/yingchuang-update-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const body = Buffer.from('映窗更新文件');
  const name = process.platform === 'win32' ? '映窗-Windows-x64.zip' : `映窗-Linux-${process.arch === 'arm64' ? 'arm64' : 'x86_64'}.AppImage`;
  const data = { ...release, assets: [{ name, size: body.length, digest: `sha256:${createHash('sha256').update(body).digest('hex')}`,
    browser_download_url: 'https://github.com/Molun0301/yingchuang/releases/download/v0.3.0/update' }] };
  const { handlers, store } = createUpdater({ current: '0.2.0', directory,
    fetch: async url => url.endsWith('/latest') ? Response.json(data) : new Response(body) });
  await handlers['update-check']();
  const downloaded = await handlers['update-download']();
  assert.deepEqual(await fs.readFile(downloaded.path), body);
  assert.equal(store.data.settings.update.pendingNotes.version, '0.3.0');
  assert.equal(store.data.settings.update.pendingNotes.notes, release.body);
  assert.equal(store.data.settings.update.pendingNotes.url, release.html_url);
  assert.equal(store.data.settings.update.pendingNotes.publishedAt, release.published_at);
  const restarted = createUpdater({ update: store.data.settings.update, fetch: async () => { throw new Error('网络不可用'); } });
  assert.equal((await restarted.handlers['update-changelog']()).notes, release.body);
});

test('手动下载可以打开 GitHub 发布页和指定夸克链接', () => {
  const { handlers, opened } = createUpdater();
  handlers['open-release']();
  handlers['open-release'](release.html_url);
  handlers['open-release']('https://pan.quark.cn/s/320e0f140cf6');
  assert.deepEqual(opened, ['https://github.com/Molun0301/yingchuang/releases/latest', release.html_url, 'https://pan.quark.cn/s/320e0f140cf6']);
  assert.throws(() => handlers['open-release']('https://pan.quark.cn/s/其他分享'), /仅支持打开/);
});
