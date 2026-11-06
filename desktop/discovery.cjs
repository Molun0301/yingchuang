const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

function parseVdf(text) {
  const tokens = String(text).replace(/^\uFEFF/, '').match(/"(?:\\.|[^"\\])*"|\{|\}|\/\/[^\n]*|[^\s{}"]+/g) || [];
  let i = 0;
  function token() {
    while (tokens[i]?.startsWith('//')) i++;
    const t = tokens[i++];
    return t?.startsWith('"') ? t.slice(1, -1).replace(/\\([\\"])/g, '$1') : t;
  }
  function object() {
    const out = {};
    while (i < tokens.length) {
      const key = token();
      if (!key || key === '}') break;
      const v = token();
      if (['__proto__', 'constructor', 'prototype'].includes(key)) continue;
      out[key] = v === '{' ? object() : v;
    }
    return out;
  }
  return object();
}

function steamCandidates(platform = process.platform, home = os.homedir(), env = process.env) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    return [...new Set([
      env['ProgramFiles(x86)'] && p.join(env['ProgramFiles(x86)'], 'Steam'),
      env.ProgramFiles && p.join(env.ProgramFiles, 'Steam'),
      env.LOCALAPPDATA && p.join(env.LOCALAPPDATA, 'Steam'),
      p.join(home, 'Steam'), 'C:\\Program Files (x86)\\Steam', 'C:\\Steam',
    ].filter(Boolean))];
  }
  return ['.local/share/Steam', '.steam/steam', '.steam/root',
    '.var/app/com.valvesoftware.Steam/.local/share/Steam',
    'snap/steam/common/.local/share/Steam', 'snap/steam/common/.steam/steam'].map(x => p.join(home, x));
}

function libraryPaths(vdf, platform = process.platform) {
  const root = vdf.libraryfolders || vdf.LibraryFolders || vdf;
  const p = platform === 'win32' ? path.win32 : path.posix;
  return Object.entries(root).filter(([k]) => /^\d+$/.test(k))
    .map(([, v]) => typeof v === 'string' ? v : v?.path)
    .filter(v => typeof v === 'string' && p.isAbsolute(v));
}

async function readJson(file) {
  try { return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, '')); } catch { return null; }
}
async function directories(folder) {
  try { return (await fs.readdir(folder, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => path.join(folder, x.name)); }
  catch { return []; }
}
async function exists(p) { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } }

async function windowsSteamRoots() {
  if (process.platform !== 'win32') return [];
  const roots = [];
  for (const [key, value] of [['HKCU\\Software\\Valve\\Steam', 'SteamPath'], ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath']]) {
    try {
      const { stdout } = await execFileAsync('reg.exe', ['query', key, '/v', value], { windowsHide: true, timeout: 2500 });
      const match = stdout.match(/REG_SZ\s+([^\r\n]+)/);
      if (match) roots.push(match[1].trim());
    } catch {}
  }
  return roots;
}

function plainText(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[\u200b-\u200f\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeProperties(project) {
  const dict = project.general?.properties || {};
  const labels = { ui_browse_properties_scheme_color: '主题颜色',
    ui_browse_properties_schemecolor: '主题颜色', ui_browse_properties_volume: '音量',
    ui_browse_properties_playbackspeed: '播放速度' };
  return Object.entries(dict).filter(([,v]) => v && typeof v === 'object').map(([key,v]) => {
    const type = String(v.type || ('value' in v ? 'textinput' : 'text')).toLowerCase();
    return { ...v, key, type, label: labels[v.text] || plainText(v.text) || key,
      options: Array.isArray(v.options) ? v.options.map(o => ({ ...o, label: plainText(o.label) })) : undefined };
  }).sort((a,b) => (a.order ?? a.index ?? 999) - (b.order ?? b.index ?? 999));
}

async function discover(extraRoots = []) {
  const candidates = [...steamCandidates(), ...await windowsSteamRoots(), ...extraRoots];
  const librarySet = new Set(), scanned = new Set(), folders = new Set(), engines = new Set();
  for (const candidate of candidates) {
    if (!candidate || !await exists(candidate)) continue;
    const real = await fs.realpath(candidate);
    if (scanned.has(real)) continue;
    scanned.add(real);
    if (await readJson(path.join(real, 'project.json'))) folders.add(real);
    for (const file of [path.join(real, 'steamapps/libraryfolders.vdf'), path.join(real, 'libraryfolders.vdf')]) {
      try {
        const libs = libraryPaths(parseVdf(await fs.readFile(file, 'utf8')));
        for (const lib of libs) librarySet.add(lib);
      } catch {}
    }
    librarySet.add(real);
  }
  const roots = [];
  for (const library of librarySet) {
    const steamapps = path.basename(library).toLowerCase() === 'steamapps' ? library : path.join(library, 'steamapps');
    const engine = path.join(steamapps, 'common/wallpaper_engine');
    if (await exists(path.join(engine, 'assets'))) engines.add(path.join(engine, 'assets'));
    const searches = [path.join(steamapps, 'workshop/content/431960'),
      path.join(engine, 'projects/myprojects'), path.join(engine, 'projects/defaultprojects')];
    if (extraRoots.includes(library)) searches.push(library, path.join(library, 'projects/myprojects'), path.join(library, 'workshop/content/431960'));
    for (const folder of searches) {
      if (!await exists(folder)) continue;
      const real = await fs.realpath(folder);
      if (!roots.includes(real)) roots.push(real);
      for (const child of await directories(real)) folders.add(child);
    }
    if (await exists(path.join(library, 'assets'))) engines.add(path.join(library, 'assets'));
  }
  const themes = [];
  const unique = new Set();
  for (const folder of folders) {
    const project = await readJson(path.join(folder, 'project.json'));
    if (!project) continue;
    const real = await fs.realpath(folder);
    if (unique.has(real)) continue;
    unique.add(real);
    const stat = await fs.stat(path.join(real, 'project.json'));
    let preview = project.preview ? path.resolve(real, project.preview) : '';
    const sourceType = String(project.type || 'scene').toLowerCase();
    let source = path.resolve(real, project.file || 'scene.pkg');
    if (sourceType === 'scene') {
      try { await fs.access(path.join(real, 'scene.pkg')); source = path.join(real, 'scene.pkg'); } catch {}
    }
    if (!preview) {
      for (const ext of ['jpg', 'png', 'gif', 'webp']) {
        try { await fs.access(path.join(real, `preview.${ext}`)); preview = path.join(real, `preview.${ext}`); break; } catch {}
      }
    }
    const props = normalizeProperties(project);
    themes.push({ id: createHash('sha256').update(real).digest('hex').slice(0, 20),
      workshopId: /^\d+$/.test(path.basename(real)) ? path.basename(real) : '',
      title: plainText(project.title) || path.basename(real), folder: real, source, type: sourceType,
      preview, properties: props, propertyValues: Object.fromEntries(props.filter(p => 'value' in p).map(p => [p.key,p.value])),
      modified: stat.mtimeMs, author: plainText(project.author), engineRoots: [...engines], project });
  }
  themes.sort((a,b) => b.modified - a.modified || a.title.localeCompare(b.title, 'zh-CN'));
  return { themes, roots, engineRoots: [...engines] };
}

module.exports = { parseVdf, steamCandidates, libraryPaths, discover, normalizeProperties, plainText };
