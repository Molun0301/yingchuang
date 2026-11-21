const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {parseVdf,steamCandidates,libraryPaths}=require('../desktop/discovery.cjs');
const {createLibrary,discover}=require('../desktop/library.cjs');
const {createResources}=require('../desktop/protocol.cjs');
const {installIpc}=require('../desktop/ipc.cjs');
const {model,Projects}=require('../desktop/projects.cjs');
const device={id:'xiaomi-18-pro-max',name:'小米 18 Pro Max'};
const widget=(project,key)=>project.widgets.find(item=>item.key===key);
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

test('WE 设置：按工坊编号或规范路径匹配，兼容 Monitor0 和扁平表，只覆盖作者已有属性',async()=>{
  const base=await fs.mkdtemp(path.join(__dirname,'settings-'));
  try{
    const steam=path.join(base,'Steam'),library=path.join(base,'Games');
    const workshop=path.join(library,'steamapps/workshop/content/431960/42'),flat=path.join(library,'steamapps/common/wallpaper_engine/projects/myprojects/本地');
    const engine=path.join(steam,'steamapps/common/wallpaper_engine');
    await fs.mkdir(engine,{recursive:true});await fs.mkdir(workshop,{recursive:true});await fs.mkdir(flat,{recursive:true});
    await fs.writeFile(path.join(steam,'steamapps/libraryfolders.vdf'),`"libraryfolders" { "1" { "path" "${library}" } }`);
    const project={file:'scene.json',general:{properties:{enabled:{type:'bool',value:true},amount:{type:'slider',value:1},text:{type:'textinput',value:'默认'},untouched:{value:9}}}};
    await fs.writeFile(path.join(workshop,'project.json'),JSON.stringify(project));await fs.writeFile(path.join(flat,'project.json'),JSON.stringify(project));
    await fs.writeFile(path.join(engine,'config.json'),JSON.stringify({userA:{wproperties:{
      'D:\\SteamLibrary\\steamapps\\workshop\\content\\431960\\42\\scene.pkg':{Monitor1:{enabled:true,amount:8},Monitor0:{enabled:{value:false},amount:0,extra:{value:99}}},
      [flat.toUpperCase().replace(/\//g,'\\')]:{enabled:false,amount:{value:.25},text:{value:''}},
      'C:/steamapps/workshop/content/431960/420/scene.pkg':{enabled:true},
    }},userB:{wproperties:{'E:/steamapps/workshop/content/431960/42/scene.pkg':{Monitor2:{text:{value:'第一台显示器'}}}}}}));
    const result=await discover([steam]);
    assert.deepEqual(result.themes.find(theme=>theme.folder===workshop).propertyValues,{enabled:false,amount:0,text:'第一台显示器',untouched:9});
    assert.deepEqual(result.themes.find(theme=>theme.folder===flat).propertyValues,{enabled:false,amount:.25,text:'',untouched:9});
  }finally{await fs.rm(base,{recursive:true,force:true});}
});

test('套用模板只修改排版，已有组件保留各自外观与壁纸设置',()=>{
  const first=model.create({properties:{birds:false}});
  Object.assign(widget(first,'time'),{font:'/自选字体.ttf',color:'#fa1234',y:.73,effect:'outline'});
  first.layers={'4':{visible:false}};
  const template={layout:model.templateLayout(first)};
  const second=model.create({properties:{birds:true,clouds:'original'},hasClock:false});
  Object.assign(widget(second,'time'),{color:'#ffffff',font:'theme:font.ttf',effect:'shadow'});
  widget(second,'week').language='zh';
  const result=model.applyTemplate(second,template);
  assert.equal(result.showWidgets,true);
  assert.equal(widget(result,'time').y,.73);
  assert.deepEqual(widget(result,'time'),{...widget(second,'time'),y:.73});
  assert.equal(widget(result,'week').language,'zh');
  assert.deepEqual(result.properties,second.properties);
  assert.deepEqual(result.layers,{});
  assert(!('deviceId'in result));
  assert.deepEqual(Object.keys(widget(template.layout,'time')).sort(),['align','key','size','x','y']);
  widget(result,'time').y=.2;
  assert.equal(widget(second,'time').y,.62);
  assert.equal(widget(template.layout,'time').y,.73);
});

test('组件定义驱动默认排版，作品中只列出已放到画面上的组件',()=>{
  const {widgets}=require('../core/组件.json'),project=model.create();
  assert.deepEqual(model.KEYS,widgets.map(item=>item.key));
  assert.deepEqual(project.widgets.map(item=>item.key),widgets.filter(item=>item.core).map(item=>item.key));
  for(const definition of widgets.filter(item=>item.core)){
    const row=widget(project,definition.key);
    assert.equal(row.x,definition.x);assert.equal(row.size,definition.size);
    assert.equal(row.font,'');assert.equal(row.color,'');
  }
  assert.equal(model.widget('text').text,widgets.find(item=>item.key==='text').sample);
});

test('组件语言逐个清洗，迁移时沿用旧草稿的星期语言与行内语言',()=>{
  for(const language of ['zh','en']){
    const project=model.migrate({layout:{clock:{language,format:'24',seconds:true,rows:{
      time:{visible:true},date:{visible:false},steps:{visible:true,language:'en'},weather:{visible:true,language:'fr'}}}}});
    assert.equal(widget(project,'week').language,language);
    assert.equal(widget(project,'steps').language,'en');
    assert.equal(widget(project,'weather').language,'zh');
    assert.equal(widget(project,'date'),undefined);
    assert.equal(widget(project,'time').hourFormat,'24');
    assert.equal(widget(project,'time').seconds,true);
  }
  assert.equal(widget(model.create(),'week').language,'en');
});

test('套用旧模板时按模板选择组件，保留已存在的组件语言',()=>{
  const project=model.create();
  widget(project,'week').language='zh';
  const result=model.applyTemplate(project,{layout:{language:'en',rows:{week:{visible:true,x:.8},time:{visible:false}}}});
  assert.deepEqual(result.widgets.map(item=>item.key),['week']);
  assert.equal(widget(result,'week').language,'zh');
  assert.equal(widget(result,'week').x,.8);
});

test('组件示例按行语言使用英文格式与选项，中文格式保持原样',()=>{
  const definitions=require('../core/组件.json'),{widgetText}=require('../core/组件绘制.cjs');
  const values={...Object.fromEntries(Object.entries(definitions.fields).filter(([,field])=>'sample'in field).map(([key,field])=>[key,field.sample])),lm:9,ld:23,w:5};
  const english={week:'FRIDAY',lunar:'Lunar 10/24',steps:'6542 steps',distance:'4.36 km',calories:'238 kcal',active:'Active 32 min',goal:'Goal 82%',
    weather:'Cloudy',humidity:'Humidity 64%',air:'AQI Good',sunrise:'Sunrise 06:42',sunset:'Sunset 17:08',battery:'Battery 86%',sms:'SMS 2',calls:'Missed 1'};
  assert.deepEqual(definitions.widgets.filter(widget=>widget.lang).map(widget=>widget.key).sort(),Object.keys(english).sort());
  for(const widget of definitions.widgets){
    assert.equal(widgetText(definitions,widget.key,{language:'zh'},values),widget.key==='week'?'星期五':widget.sample);
    if(widget.lang)assert.equal(widgetText(definitions,widget.key,{language:'en'},values),english[widget.key]);
  }
  assert.equal(widgetText(definitions,'lunar',{language:'en'},{...values,lm:23,ld:29}),'Lunar L12/30');
  assert.equal(widgetText(definitions,'lunar',{language:'en',label:false},{...values,lm:12,ld:0}),'L1/1');
  assert.equal(widgetText(definitions,'steps',{language:'en',label:false},values),'6542');
  for(const [field,key] of [['wx','weather'],['air','air'],['lm','lunar'],['ld','lunar']]){
    const options=definitions.fields[field];assert.equal(options.choices.length,options.choices_en.length);
    for(let index=0;index<options.choices_en.length;index++)assert(widgetText(definitions,key,{language:'en'},{...values,[field]:index}).includes(options.choices_en[index]));
  }
});

test('水平翻转随作品保存，模板双向套用均保留当前翻转',()=>{
  for(const sourceFlip of [true,false])for(const targetFlip of [true,false]){
    const first=model.create();first.framing.flip=sourceFlip;widget(first,'time').x=.88;
    const template={layout:model.templateLayout(first)},second=model.create();second.framing.flip=targetFlip;
    assert.equal('flip' in template.layout.framing,false);assert.equal(model.normalize(first).framing.flip,sourceFlip);
    const result=model.applyTemplate(second,template);
    assert.equal(result.framing.flip,targetFlip);assert.equal(widget(result,'time').x,.88);
  }
});

test('作品保存组件标签和自定义文字，模板只保存所选组件与排版',()=>{
  const project=model.create(),text='今天开心🌻'.repeat(12);
  project.widgets.push({key:'steps',label:false,font:'/字体.ttf',color:'#88aa99'},{key:'text',text});
  const result=model.normalize(project),template=model.templateLayout(result);
  assert.equal(widget(result,'steps').label,false);
  assert.equal(widget(result,'steps').font,'/字体.ttf');
  assert.equal(widget(result,'text').text,[...text].slice(0,40).join(''));
  assert.equal(widget(project,'text').text,text);
  assert(!('label'in widget(template,'steps')));
  assert(!('text'in widget(template,'text')));
});

test('排版与收藏重新启动后仍在',async()=>{
  const dir=await fs.mkdtemp(path.join(__dirname,'store-'));
  try{
    const store=new Store(dir),projects=new Projects(store);
    store.update(data=>{data.favorites=['wallpaper'];});
    projects.saveTemplate('样式',model.create());
    projects.renameTemplate(store.data.templates[0].id,'排版');
    const reopened=new Store(dir);
    assert.deepEqual(reopened.data.favorites,['wallpaper']);
    assert.equal(reopened.data.templates[0].name,'排版');
    assert.equal(reopened.snapshot().templates.length,model.builtinTemplates().length+1);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('v1 存储读入后写回 v2，保留全局设置、作品内容与旧模板排版',async()=>{
  const dir=await fs.mkdtemp(path.join(__dirname,'migration-')),file=path.join(dir,'映窗.json');
  try{
    const time={visible:true,x:.7,y:.63,size:62,align:'left'};
    await fs.writeFile(file,JSON.stringify({version:1,favorites:['a'],settings:{deviceId:device.id},
      drafts:{a:{version:1,deviceId:'旧机型',layout:{x:.64,flip:true,clock:{rows:{time},format:'12'}},
        appearance:{fonts:{time:'theme:font.ttf'},colors:{time:'#ff1122'}},properties:{speed:2}}},
      templates:[{id:'saved',name:'原模板',layout:{x:.81,clockEnabled:false,rows:{time}}}]}));
    const migrated=new Store(dir),data=JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(data.version,2);assert(!('drafts'in data));assert(!('deviceId'in data.projects.a));
    assert.deepEqual(data,migrated.data);
    assert.deepEqual(new Store(dir).data,data);
    assert.deepEqual(data.favorites,['a']);assert.equal(data.settings.deviceId,device.id);
    assert.equal(data.projects.a.framing.x,.64);assert.equal(data.projects.a.framing.flip,true);
    assert.equal(widget(data.projects.a,'time').font,'theme:font.ttf');
    assert.equal(widget(data.projects.a,'time').color,'#ff1122');
    assert.equal(widget(data.projects.a,'time').hourFormat,'12');
    assert.equal(data.projects.a.properties.speed,2);
    assert.deepEqual(data.templates[0].layout,{framing:{scale:1.06,x:.81,y:.5},showWidgets:false,
      widgets:[{key:'time',x:.7,y:.63,size:62,align:'left'}]});
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('只把壁纸设置的差异写入作品，重启后与当前默认值合并',async()=>{
  const dir=await fs.mkdtemp(path.join(__dirname,'properties-'));
  try{
    const store=new Store(dir),projects=new Projects(store);
    const theme={id:'a',propertyValues:{stars:true,level:9,tint:[1,0,0],message:'默认'}};
    projects.save(theme,model.create({properties:{...theme.propertyValues,stars:false,level:0,message:''}}));
    const reopened=new Store(dir);
    assert.deepEqual(reopened.data.projects.a.properties,{stars:false,level:0,message:''});
    const current=await new Projects(reopened).forTheme({...theme,propertyValues:{...theme.propertyValues,tint:[0,0,1],volume:50}});
    assert.deepEqual(current.properties,{stars:false,level:0,tint:[0,0,1],message:'',volume:50});
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('批量任务使用快照，单项失败后继续下一项',async()=>{
  const seen=[];let release;
  const gate=new Promise(resolve=>{release=resolve;});
  const queue=new ConversionQueue(async(input,_signal,progress)=>{await gate;seen.push(input.project.properties.value);progress({progress:55,phase:'转换'});if(input.theme.id==='one')throw new Error('单项失败');return{buildId:'two',size:20};});
  const input={theme:{id:'one',title:'一'},project:model.create({properties:{value:'原值'}}),device};
  queue.add([input,{theme:{id:'two',title:'二'},project:model.create({properties:{value:'第二项'}}),device}]);input.project.properties.value='后来更改';release();
  await new Promise(resolve=>{const check=items=>{if(items.every(x=>['error','done'].includes(x.status))){queue.off('change',check);resolve();}};queue.on('change',check);});
  assert.deepEqual(seen,['原值','第二项']);assert.deepEqual(queue.snapshot().map(x=>x.status),['error','done']);
});

test('取消停止当前任务并取消全部待处理任务',async()=>{
  let started=0;
  const queue=new ConversionQueue((_input,signal)=>new Promise((_resolve,reject)=>{started++;signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});}));
  queue.add(['one','two','three'].map(id=>({theme:{id,title:id},project:model.create(),device})));queue.cancel();
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

test('完整画面循环：周期内容原样输出，非周期内容在接缝处过渡到循环起点',async()=>{
  const {LoopWriter}=require('../desktop/recorder.cjs');
  const run=async values=>{const written=[];const loop=new LoopWriter({write:async frame=>{written.push(frame[0]);}},20,4);for(const v of values)await loop.push(Buffer.from([v]));assert(loop.complete);return written;};
  // 周期恰为 20 帧的内容：混合段两边相同，输出就是从第 4 帧开始的完整一圈。
  const periodic=Array.from({length:24},(_,i)=>(i%20)*10);
  assert.deepEqual(await run(periodic),[...periodic.slice(4,20),...periodic.slice(0,4)]);
  // 非周期内容：最后一帧接近第 3 帧，下一轮从第 4 帧开始，接缝处不出现整段跳变。
  const drifting=Array.from({length:24},(_,i)=>i*10);
  const written=await run(drifting);
  assert.equal(written.length,20);assert.equal(written[0],40);
  assert(Math.abs(written[19]-30)<Math.abs(written[19]-230));
  assert(written.slice(16).every((v,i,a)=>i===0||v<a[i-1]),'混合段应逐帧靠近开头画面');
});

test('取景留边：录制区域始终落在整幅画面内，尺寸为偶数',()=>{
  const {frameScene,recordSize}=require('../desktop/framing.cjs');
  // 缩放不小于 100% 时场景覆盖整个屏幕，录制区域不应越出整幅画面。
  for(const [sw,sh] of [[3840,2160],[1920,1080],[1080,1920],[976,596]])for(const scale of [1,1.06,3])for(const x of [0,.5,1])for(const amount of [0,.02,.1]){
    const f=frameScene(sw,sh,976,596,{scale,x,y:1-x},amount,.3),size=recordSize(976,596,f);
    const full={width:Math.ceil(sw*f.scale),height:Math.ceil(sh*f.scale)},cx=Math.round(-976*f.marginX-f.left),cy=Math.round(-596*f.marginY-f.top);
    assert(size.width%2===0&&size.height%2===0);
    assert(cx>=0&&cy>=0&&cx+size.width<=full.width+1&&cy+size.height<=full.height+1,JSON.stringify({sw,sh,scale,x,amount}));
  }
});

test('没有 type 字段的旧工程按入口文件判断网页、应用和场景',async()=>{
  const base=await fs.mkdtemp(path.join(__dirname,'types-'));
  try{
    for(const [name,file] of [['app','sheep.exe'],['page','index.html'],['legacy','legacy.json'],['clip','movie.webm']]){
      await fs.mkdir(path.join(base,name));await fs.writeFile(path.join(base,name,'project.json'),JSON.stringify({title:name,file}));
    }
    const types=Object.fromEntries((await discover([base])).themes.filter(t=>t.folder.startsWith(base)).map(t=>[t.title,t.type]));
    assert.deepEqual(types,{app:'application',page:'web',legacy:'scene',clip:'video'});
    const app=(await discover([base])).themes.find(theme=>theme.title==='app'&&theme.folder.startsWith(base));
    assert.equal(app.available,process.platform==='win32');
    assert.equal(app.reason,process.platform==='win32'?undefined:'应用壁纸只能在 Windows 上录制');
  }finally{await fs.rm(base,{recursive:true,force:true});}
});

async function writeWallpaper(folder,project) {
  await fs.mkdir(folder,{recursive:true});
  await fs.writeFile(path.join(folder,'project.json'),JSON.stringify(project));
}

test('预设跨根目录沿用原壁纸素材和作者设置，工坊用户设置只覆盖该预设',async()=>{
  const dir=await fs.mkdtemp(path.join(__dirname,'preset-'));
  try{
    const base=path.join(dir,'手动目录','100');
    const engine=path.join(dir,'steamapps/common/wallpaper_engine');
    const workshop=path.join(dir,'steamapps/workshop/content/431960');
    const preset=path.join(workshop,'200'),missing=path.join(engine,'projects/myprojects','300');
    const original={title:'原壁纸',type:'scene',file:'scene.json',preview:'preview.jpg',
      general:{properties:{rain:{type:'bool',value:false},speed:{type:'slider',value:1},volume:{value:10}}}};
    await writeWallpaper(base,original);
    await fs.writeFile(path.join(base,'preview.jpg'),'封面');
    await fs.writeFile(path.join(base,'scene.pkg'),'源素材');
    await writeWallpaper(preset,{title:'预设壁纸',dependency:100,preset:{rain:true,speed:3}});
    await writeWallpaper(missing,{title:'未订阅预设',dependency:'999',preview:'cover.png'});
    await fs.writeFile(path.join(missing,'cover.png'),'自己的封面');
    await fs.writeFile(path.join(engine,'config.json'),JSON.stringify({user:{wproperties:{
      'D:/steamapps/workshop/content/431960/200/project.json':{Monitor0:{volume:{value:0}}},
      [base]:{speed:9,volume:22},
    }}}));

    const store=new Store(path.join(dir,'data'));store.data.settings.roots=[dir,path.dirname(base)];
    const resources=createResources(dir);
    const library=createLibrary({store,resources,onScan(){},onChange(){}});
    try{
      await library.scan();
      const theme=library.themeById('200'),unavailable=library.current.themes.find(item=>item.title==='未订阅预设');
      const baseTheme=library.current.themes.find(item=>item.title==='原壁纸');
      assert.match(baseTheme.id,/^[a-f0-9]{20}$/);assert.equal(baseTheme.workshopId,'');
      assert.match(unavailable.id,/^[a-f0-9]{20}$/);
      assert.equal(theme.title,'预设壁纸');assert.equal(theme.ownFolder,preset);assert.equal(theme.folder,base);
      assert.equal(theme.source,path.join(base,'scene.pkg'));assert.equal(theme.preview,path.join(base,'preview.jpg'));
      assert.deepEqual(theme.propertyValues,{rain:true,speed:3,volume:0});
      assert.deepEqual(theme.properties.map(item=>item.value),[true,3,10]);
      assert.deepEqual(library.liveTheme(theme).project,original);
      assert.deepEqual(library.publicTheme(theme).preset,{base:'100',baseTitle:'原壁纸',missing:false});
      assert.equal(library.publicTheme(theme).available,true);
      assert.equal(unavailable.preview,path.join(missing,'cover.png'));
      assert.equal(unavailable.available,false);
      assert.deepEqual(unavailable.preset,{base:'999',baseTitle:'',missing:true});
      const opened=[];
      const {handlers}=installIpc({ipcMain:{handle(){}},store,library,resources,workers:{},
        shell:{openPath:folder=>opened.push(folder)},pipeline:{inspect:()=>assert.fail('缺失原壁纸时不能请求 Python')},previews:{}});
      await assert.rejects(handlers.get('detail')(unavailable.id),{message:'需要先在 Steam 订阅原壁纸'});
      await handlers.get('open-theme')('200');assert.deepEqual(opened,[preset]);
    }finally{library.close();}
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('扫描迁移旧工坊路径键和 v1 全量属性，保留新键已有的作品与成品',async()=>{
  const {createHash}=require('node:crypto');
  const dir=await fs.mkdtemp(path.join(__dirname,'identity-'));
  try{
    const root=path.join(dir,'steamapps/workshop/content/431960'),first=path.join(root,'41'),second=path.join(root,'42');
    const source={type:'scene',general:{properties:{rain:{value:true},speed:{value:1}}}};
    await writeWallpaper(first,source);await writeWallpaper(second,source);
    const key=async folder=>createHash('sha256').update(await fs.realpath(folder)).digest('hex').slice(0,20);
    const old=await key(first),conflict=await key(second);
    const folder=path.join(dir,'data');await fs.mkdir(folder);
    const file=path.join(folder,'映窗.json');
    await fs.writeFile(file,JSON.stringify({version:1,favorites:[old,conflict,'42'],settings:{roots:[dir]},templates:[],
      drafts:{[old]:{properties:{rain:true,speed:3}},[conflict]:{properties:{speed:7}},'42':{properties:{speed:9}}},
      builds:[{id:'1',themeId:old,deviceId:'a'},{id:'2',themeId:conflict,deviceId:'b'},
        {id:'3',themeId:'42',deviceId:'b'},{id:'4',themeId:conflict,deviceId:'c'}]}));
    const store=new Store(folder);
    const library=createLibrary({store,resources:createResources(dir),onScan(){},onChange(){}});
    try{
      await library.scan();
      const data=JSON.parse(await fs.readFile(file,'utf8'));
      assert.deepEqual(data.favorites,['41',conflict,'42']);
      assert.deepEqual(data.projects['41'].properties,{speed:3});assert(!Object.hasOwn(data.projects,old));
      assert.deepEqual(data.projects['42'].properties,{speed:9});
      assert.deepEqual(data.projects[conflict].properties,{speed:7});
      assert.deepEqual(data.builds.map(record=>record.themeId),['41',conflict,'42','42']);
      const project=await new Projects(store).forTheme(library.themeById('41'));
      assert.deepEqual(project.properties,{rain:true,speed:3});
    }finally{library.close();}
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
