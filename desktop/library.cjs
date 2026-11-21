const path = require('node:path');
const fs = require('node:fs/promises');
const { watch } = require('node:fs');
const { createHash } = require('node:crypto');
const { readJson, discoverFolders } = require('./discovery.cjs');
const { propertyDifferences } = require('./projects.cjs');

const MISSING_PRESET = '需要先在 Steam 订阅原壁纸';
const WINDOWS_ONLY = '应用壁纸只能在 Windows 上录制';
const FULL_TYPES = new Set(['scene', 'web', 'application']);

function plainText(value) {
  return String(value ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/[\u200b-\u200f\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

function normalizeProperties(project) {
  const dict = project.general?.properties || {};
  const labels = { ui_browse_properties_scheme_color: '壁纸颜色',
    ui_browse_properties_schemecolor: '壁纸颜色', ui_browse_properties_volume: '音量',
    ui_browse_properties_playbackspeed: '播放速度' };
  return Object.entries(dict).filter(([,v]) => v && typeof v === 'object').map(([key,v]) => {
    const type = String(v.type || ('value' in v ? 'textinput' : 'text')).toLowerCase();
    return { ...v, key, type, label: labels[v.text] || plainText(v.text) || key,
      options: Array.isArray(v.options) ? v.options.map(o => ({ ...o, label: plainText(o.label) })) : undefined };
  }).sort((a,b) => (a.order ?? a.index ?? 999) - (b.order ?? b.index ?? 999));
}

/** WE 按用户、壁纸路径存设置；同一创意工坊壁纸换过库目录后仍沿用这些值。 */
function wallpaperValues(configs, folder, properties, workshop) {
  const normalize = value => value.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
  const themePath = normalize(folder);
  const values = Object.fromEntries(properties.filter(p => 'value' in p).map(p => [p.key, p.value]));
  const keys = new Set(properties.map(p => p.key));
  for (const config of configs) for (const user of Object.values(config)) {
    for (const [location, saved] of Object.entries(user.wproperties || {})) {
      const normalized = normalize(location);
      if (normalized !== themePath && !(workshop && (normalized + '/').includes(`/431960/${workshop}/`))) continue;
      const table = Object.keys(saved).some(key => /^Monitor/i.test(key)) ? saved.Monitor0 ?? Object.values(saved)[0] : saved;
      for (const [key, value] of Object.entries(table)) if (keys.has(key))
        values[key] = value && typeof value === 'object' && 'value' in value ? value.value : value;
    }
  }
  return values;
}

async function readTheme(folder, workshopId, engineRoots) {
  const project=await readJson(path.join(folder,'project.json'));
  if(!project)return null;
  const real=await fs.realpath(folder);
  const modified=(await fs.stat(path.join(real,'project.json'))).mtimeMs;
  const pathId=createHash('sha256').update(real).digest('hex').slice(0,20);
  const name=path.basename(folder);
  const base=project.dependency&&!project.type&&!project.file?String(project.dependency):'';
  let preview=project.preview?path.resolve(real,project.preview):'';
  if(base&&preview&&!await fs.access(preview).then(()=>true,()=>false))preview='';
  if(!preview)for(const ext of ['jpg','png','gif','webp']){
    try{await fs.access(path.join(real,`preview.${ext}`));preview=path.join(real,`preview.${ext}`);break;}catch{}
  }
  const common={id:workshopId||pathId,pathId,workshopId,name,title:plainText(project.title)||name,
    ownFolder:real,folder:real,preview,modified,author:plainText(project.author),engineRoots,project};
  if(base)return {...common,preset:{base,baseTitle:'',missing:true}};

  // 早期官方工程没有 type 字段，按入口文件判断类型。
  const extension=path.extname(String(project.file||'')).toLowerCase();
  const inferred=['.html','.htm'].includes(extension)?'web':extension==='.exe'?'application'
    : ['.mp4','.webm','.mkv','.mov','.avi','.m4v','.wmv','.ogv'].includes(extension)?'video':'scene';
  const type=String(project.type||inferred).toLowerCase();
  let source=path.resolve(real,project.file||'scene.pkg');
  if(type==='scene'){
    try{await fs.access(path.join(real,'scene.pkg'));source=path.join(real,'scene.pkg');}catch{}
  }
  return {...common,type,source,properties:normalizeProperties(project)};
}

async function discover(extraRoots = []) {
  const {folders,roots,configs,engineRoots}=await discoverFolders(extraRoots);
  const byPath=new Map();
  for(const [folder,id] of folders){
    const theme=await readTheme(folder,id,engineRoots);
    if(theme&&(!byPath.has(theme.ownFolder)||theme.workshopId))byPath.set(theme.ownFolder,theme);
  }
  const originals=new Map();
  for(const theme of byPath.values())if(!theme.preset&&!originals.has(theme.name))originals.set(theme.name,theme);
  const themes=[...byPath.values()].map(theme=>{
    if(theme.preset){
      const original=originals.get(theme.preset.base);
      if(!original)return {...theme,type:'',available:false,reason:MISSING_PRESET,properties:[],propertyValues:{}};
      const settings=theme.project.preset||{};
      theme={...theme,type:original.type,source:original.source,folder:original.folder,project:original.project,
        preview:theme.preview||original.preview,preset:{...theme.preset,baseTitle:original.title,missing:false},
        properties:original.properties.map(property=>Object.hasOwn(settings,property.key)?{...property,value:settings[property.key]}:property)};
    }
    const propertyValues=wallpaperValues(configs,theme.ownFolder,theme.properties,theme.workshopId);
    const available=theme.type!=='application'||process.platform==='win32';
    return {...theme,propertyValues,available,...(available?{}:{reason:WINDOWS_ONLY})};
  });
  themes.sort((a,b)=>b.modified-a.modified||a.title.localeCompare(b.title,'zh-CN'));
  return {themes,roots,engineRoots};
}

function migrateThemeIds(data, themes) {
  let changed=false;
  for(const {id,pathId} of themes){
    if(id===pathId)continue;
    const favorite=data.favorites.indexOf(pathId);
    if(favorite!==-1&&!data.favorites.includes(id)){data.favorites[favorite]=id;changed=true;}
    if(Object.hasOwn(data.projects,pathId)&&!Object.hasOwn(data.projects,id)){
      data.projects[id]=data.projects[pathId];delete data.projects[pathId];changed=true;
    }
    const devices=new Set(data.builds.filter(record=>record.themeId===id).map(record=>record.deviceId));
    for(const record of data.builds){
      if(record.themeId!==pathId||devices.has(record.deviceId))continue;
      record.themeId=id;devices.add(record.deviceId);changed=true;
    }
  }
  return changed;
}

function fullAvailable(theme) { return theme.available&&FULL_TYPES.has(theme.type); }

function createLibrary({store,resources,onScan,onChange}) {
  const {fileUrl,liveRoot}=resources;
  const watchers=new Map();
  let current={themes:[],roots:[]},scanned=false,closed=false,timer,scanning=Promise.resolve();

  function publicTheme(theme) {
    const {id,title,type,preview,author,workshopId,modified,available,reason,preset,properties}=theme;
    return {id,title,type,preview:fileUrl(preview),author,workshopId,modified,available,
      ...(reason?{reason}:{}),...(preset?{preset}:{}),propertyCount:properties.filter(item=>!['text','group'].includes(item.type)).length};
  }
  function liveTheme(theme) {
    const project=theme.project;
    return {key:theme.id+':'+theme.modified,type:theme.type,base:liveRoot(theme.folder),engine:liveRoot(theme.engineRoots[0]),
      file:project.file||path.basename(theme.source),pkg:path.basename(theme.source).toLowerCase()==='scene.pkg',project};
  }
  function themeById(id) {
    const theme=current.themes.find(item=>item.id===id);
    if(!theme)throw new Error('壁纸已移走，请刷新壁纸库。');
    return theme;
  }

  function scheduleScan() {
    if(closed)return;
    clearTimeout(timer);
    timer=setTimeout(()=>{void scan().then(()=>{if(!closed)onChange();},console.error);},1500);
  }
  function watchRoots(roots) {
    for(const [root,watcher] of watchers)if(!roots.includes(root)){watcher.close();watchers.delete(root);}
    for(const root of roots)if(!watchers.has(root)){
      try{
        const watcher=watch(root,{recursive:false},scheduleScan);
        watcher.on('error',()=>{watcher.close();watchers.delete(root);scheduleScan();});
        watchers.set(root,watcher);
      }catch(error){if(error.code!=='ENOENT')console.error(error);}
    }
  }

  function scan() {
    const task=scanning.then(async()=>{
      if(closed)return;
      const result=await discover(store.data.settings.roots);
      if(closed)return;
      let changed=migrateThemeIds(store.data,result.themes);
      const unique=new Map();
      for(const theme of result.themes)if(!unique.has(theme.id))unique.set(theme.id,theme);
      // 旧作品可能带着完整属性表，等原壁纸可读时才可移除与默认值相同的项。
      for(const theme of unique.values()){
        const saved=store.data.projects[theme.id];
        if(!saved||theme.preset?.missing)continue;
        const properties=propertyDifferences(saved.properties,theme.propertyValues);
        if(Object.keys(properties).length!==Object.keys(saved.properties).length){
          saved.properties=properties;changed=true;
        }
      }
      if(changed)store.save();
      current={roots:result.roots,themes:[...unique.values()]};scanned=true;
      onScan();
      watchRoots(current.roots);
    });
    scanning=task.catch(()=>{});
    return task;
  }

  function close() {
    closed=true;clearTimeout(timer);
    for(const watcher of watchers.values())watcher.close();
    watchers.clear();
  }
  return {themeById,publicTheme,liveTheme,scan,close,get current(){return current;},get scanned(){return scanned;}};
}

module.exports = { createLibrary, discover, fullAvailable };
