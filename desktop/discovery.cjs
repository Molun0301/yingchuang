const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
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

function isWorkshop(folder) { return /(?:^|[\\/])workshop[\\/]content[\\/]431960$/i.test(folder); }

async function discoverFolders(extraRoots) {
  const candidates = [...steamCandidates(), ...await windowsSteamRoots(), ...extraRoots];
  const librarySet = new Set(), scanned = new Set(), folders = new Map(), engines = new Set(), manual = new Set();
  for (const candidate of candidates) {
    if (!candidate || !await exists(candidate)) continue;
    const real = await fs.realpath(candidate);
    if (extraRoots.includes(candidate)) manual.add(real);
    if (scanned.has(real)) continue;
    scanned.add(real);
    if (await readJson(path.join(real, 'project.json'))) {
      const name=path.basename(path.resolve(candidate));
      folders.set(real,isWorkshop(path.dirname(path.resolve(candidate)))&&/^\d+$/.test(name)?name:'');
    }
    for (const file of [path.join(real, 'steamapps/libraryfolders.vdf'), path.join(real, 'libraryfolders.vdf')]) {
      try {
        const libs = libraryPaths(parseVdf(await fs.readFile(file, 'utf8')));
        for (const lib of libs) librarySet.add(lib);
      } catch {}
    }
    librarySet.add(real);
  }
  const roots = [], configs = [];
  for (const library of librarySet) {
    const steamapps = path.basename(library).toLowerCase() === 'steamapps' ? library : path.join(library, 'steamapps');
    const engine = path.join(steamapps, 'common/wallpaper_engine');
    const config = await readJson(path.join(engine, 'config.json'));
    if (config) configs.push(config);
    if (await exists(path.join(engine, 'assets'))) engines.add(path.join(engine, 'assets'));
    const searches = [path.join(steamapps, 'workshop/content/431960'),
      path.join(engine, 'projects/myprojects'), path.join(engine, 'projects/defaultprojects')];
    if (manual.has(library)) searches.push(library, path.join(library, 'projects/myprojects'),
      path.join(library, 'projects/defaultprojects'), path.join(library, 'workshop/content/431960'));
    for (const folder of searches) {
      if (!await exists(folder)) continue;
      const real = await fs.realpath(folder);
      if (!roots.includes(real)) roots.push(real);
      for (const child of await directories(real)) {
        const name=path.basename(child);
        if(isWorkshop(folder)&&/^\d+$/.test(name))folders.set(child,name);
        else if(!folders.has(child))folders.set(child,'');
      }
    }
    if (await exists(path.join(library, 'assets'))) engines.add(path.join(library, 'assets'));
  }
  return { folders, roots, configs, engineRoots: [...engines] };
}

module.exports = { parseVdf, steamCandidates, libraryPaths, readJson, discoverFolders };
