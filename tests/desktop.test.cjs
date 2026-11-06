const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {parseVdf,steamCandidates,libraryPaths,discover}=require('../desktop/discovery.cjs');
const {defaultDraft,makeTemplate,applyTemplate,builtinTemplates}=require('../desktop/model.cjs');
const {ConversionQueue}=require('../desktop/queue.cjs');
const {Store}=require('../desktop/store.cjs');

test('发现 Steam 新旧多库路径，并保留 Windows 反斜杠',()=>{
  const vdf=parseVdf('"libraryfolders" { "0" { "path" "C:\\\\Program Files (x86)\\\\Steam" "apps" { "431960" "10" } } // 库目录\n "1" { "path" "D:\\\\我的游戏" } }');
  assert.deepEqual(libraryPaths(vdf,'win32'),['C:\\Program Files (x86)\\Steam','D:\\我的游戏']);
  assert.deepEqual(libraryPaths(parseVdf('"LibraryFolders" { "TimeNextStatsReport" "0" "1" "E:\\\\SteamLibrary" }'),'win32'),['E:\\SteamLibrary']);
  const linux=steamCandidates('linux','/home/test',{});
  assert(linux.includes('/home/test/.var/app/com.valvesoftware.Steam/.local/share/Steam'));
  assert(linux.includes('/home/test/snap/steam/common/.local/share/Steam'));
});

test('手动根目录与多库扫描能找到实际项目，重复路径不重复',async()=>{
  const base=await fs.mkdtemp(path.join(__dirname,'scan-'));
  try{
    const steam=path.join(base,'Steam'),library=path.join(base,'Games'),folder=path.join(library,'steamapps/workshop/content/431960/42');
    await fs.mkdir(path.join(steam,'steamapps'),{recursive:true});await fs.mkdir(folder,{recursive:true});
    await fs.writeFile(path.join(steam,'steamapps/libraryfolders.vdf'),`"libraryfolders" { "1" { "path" "${library}" } }`);
    await fs.writeFile(path.join(folder,'project.json'),JSON.stringify({title:'测试主题',type:'scene',file:'scene.json',general:{properties:{stars:{type:'bool',value:true,text:'星星'}}}}));
    await fs.writeFile(path.join(folder,'scene.pkg'),'sample');
    const result=await discover([steam,folder]);const matches=result.themes.filter(x=>x.folder===folder);
    assert.equal(matches.length,1);assert.equal(matches[0].source,path.join(folder,'scene.pkg'));assert.equal(matches[0].propertyValues.stars,true);
  }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('模板只迁移布局，不带走字体、颜色、主题属性和机型',()=>{
  const first=defaultDraft({birds:false});first.deviceId='xiaomi-17-pro';first.appearance.fonts.time='/自选字体.ttf';first.appearance.colors.time='#fa1234';first.layout.clock.rows.time.y=.73;first.layers={'4':{visible:false}};
  const template=makeTemplate('落款',first.layout);
  const second=defaultDraft({birds:true,clouds:'original'});second.appearance.colors.time='#ffffff';second.appearance.fonts.time='theme:font.ttf';
  const result=applyTemplate(second,template);
  assert.equal(result.layout.clock.rows.time.y,.73);assert.deepEqual(result.properties,second.properties);assert.deepEqual(result.appearance,second.appearance);
  assert.equal(result.deviceId,second.deviceId);assert.deepEqual(result.layers,{});assert(!JSON.stringify(template).includes('fonts'));
  assert.equal(applyTemplate(defaultDraft({},false),template).layout.clock.enabled,true);
  result.layout.clock.rows.time.y=.2;assert.equal(second.layout.clock.rows.time.y,.62);assert.equal(template.layout.rows.time.y,.73);
});

test('排版与收藏重新启动后仍在',async()=>{
  const dir=await fs.mkdtemp(path.join(__dirname,'store-'));
  try{const a=new Store(dir);a.update(d=>{d.favorites=['wallpaper'];d.templates.push(makeTemplate('样式',defaultDraft().layout));d.drafts.wallpaper=defaultDraft({test:17});});
    const b=new Store(dir);assert.deepEqual(b.data.favorites,['wallpaper']);assert.equal(b.data.templates[0].name,'样式');assert.equal(b.data.drafts.wallpaper.properties.test,17);assert.equal(b.snapshot().templates.length,builtinTemplates().length+1);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('批量任务使用快照，单项失败后继续下一项',async()=>{
  const seen=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const queue=new ConversionQueue(async(input,_signal,progress)=>{await gate;seen.push(input.draft.properties.value);progress({progress:55,phase:'转换'});if(input.theme.id==='one')throw new Error('单项失败');return{folder:'/output/two'};});
  const input={theme:{id:'one',title:'一'},draft:defaultDraft({value:'原值'})};
  queue.add([input,{theme:{id:'two',title:'二'},draft:defaultDraft({value:'第二项'})}]);input.draft.properties.value='后来更改';release();
  await new Promise(resolve=>{const check=items=>{if(items.every(x=>['error','done'].includes(x.status))){queue.off('change',check);resolve();}};queue.on('change',check);});
  assert.deepEqual(seen,['原值','第二项']);assert.deepEqual(queue.snapshot().map(x=>x.status),['error','done']);
});

test('取消停止当前任务并取消全部待处理任务',async()=>{
  let started=0;
  const queue=new ConversionQueue((_input,signal)=>new Promise((_resolve,reject)=>{started++;signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}));
  queue.add(['one','two','three'].map(id=>({theme:{id,title:id},draft:defaultDraft()})));queue.cancel();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(started,1);assert.deepEqual(queue.snapshot().map(x=>x.status),['cancelled','cancelled','cancelled']);
});

test('作者条件支持布尔组合，陌生条件不会误隐藏控件',async()=>{
  const {conditionVisible}=await import('../src/conditions.ts');
  assert.equal(conditionVisible('a.value == true && b.value >= 2',{a:true,b:3}),true);
  assert.equal(conditionVisible('a.value == true && b.value >= 2',{a:false,b:3}),false);
  assert.equal(conditionVisible('!a.value || (mode.value == "night" && level.value > .2)',{a:false}),true);
  assert.equal(conditionVisible('level.value > .2',{level:.3}),true);
  assert.equal(conditionVisible('level.value === 2',{level:'2'}),false);
  assert.equal(conditionVisible('unknown(value)',{}),true);
});
