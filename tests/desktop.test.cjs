const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {parseVdf,steamCandidates,libraryPaths,discover}=require('../desktop/discovery.cjs');
const {ROWS,defaultDraft,cleanLayout,makeTemplate,applyTemplate,builtinTemplates}=require('../desktop/model.cjs');
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

test('组件定义驱动默认排版，旧草稿补齐隐藏的新组件并保留原设置',()=>{
  const {widgets}=require('../core/组件.json'),draft=defaultDraft();
  assert.deepEqual(ROWS,widgets.map(widget=>widget.key));
  for(const widget of widgets){
    const row=draft.layout.clock.rows[widget.key];
    assert.equal(row.visible,Boolean(widget.core));assert.equal(row.x,widget.x);assert.equal(row.size,widget.size);
    assert.equal(draft.appearance.fonts[widget.key],'');assert.equal(draft.appearance.colors[widget.key],'');
  }
  const layout=cleanLayout({clock:{language:'zh',rows:{time:{visible:false,x:.81,size:92}}}});
  assert.equal(layout.clock.rows.time.visible,false);assert.equal(layout.clock.rows.time.x,.81);assert.equal(layout.clock.rows.time.size,92);
  assert.equal(layout.clock.language,'zh');assert.equal(layout.clock.rows.steps.visible,false);
  assert.equal(layout.clock.rows.text.text,widgets.find(widget=>widget.key==='text').sample);
});

test('组件语言逐行清洗，旧草稿的星期沿用原语言，其余默认中文',()=>{
  for(const language of ['zh','en']){
    const layout=cleanLayout({clock:{language}});
    for(const key of ROWS)assert.equal(layout.clock.rows[key].language,key==='week'?language:'zh');
    const saved=cleanLayout({clock:{language,rows:{week:{language:language==='zh'?'en':'zh'},steps:{language:'en'},weather:{language:'fr'}}}});
    assert.equal(saved.clock.rows.week.language,language==='zh'?'en':'zh');
    assert.equal(saved.clock.rows.steps.language,'en');assert.equal(saved.clock.rows.weather.language,'zh');
  }
  assert.equal(defaultDraft().layout.clock.rows.week.language,'en');
});

test('套用新旧模板均保留草稿各行语言，缩略图保留模板的语言示例',()=>{
  const first=defaultDraft(),second=defaultDraft();
  first.layout.clock.rows.week.language='zh';first.layout.clock.rows.steps.language='en';first.layout.clock.rows.steps.x=.8;
  const template=makeTemplate('双语组件',first.layout);
  second.layout.clock.rows.weather.language='en';
  const result=applyTemplate(second,template);
  for(const key of ROWS)assert.equal(result.layout.clock.rows[key].language,second.layout.clock.rows[key].language);
  assert.equal(result.layout.clock.rows.steps.x,.8);
  assert.equal(template.layout.rows.week.language,'zh');assert.equal(template.layout.rows.steps.language,'en');
  const legacy=defaultDraft();legacy.layout.clock.language='zh';
  for(const key of ROWS)delete legacy.layout.clock.rows[key].language;
  const migrated=applyTemplate(legacy,template);
  assert.equal(migrated.layout.clock.rows.week.language,'zh');assert.equal(migrated.layout.clock.rows.steps.language,'zh');
  assert.equal(applyTemplate(second,{layout:{...template.layout,rows:{time:template.layout.rows.time}}}).layout.clock.rows.weather.language,'en');
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

test('水平翻转只随草稿保存，模板双向套用均不改变当前翻转',()=>{
  for(const sourceFlip of [true,false])for(const targetFlip of [true,false]){
    const first=defaultDraft();first.layout.flip=sourceFlip;first.layout.clock.rows.time.x=.88;
    const template=makeTemplate('靠右',first.layout),second=defaultDraft();second.layout.flip=targetFlip;
    assert.equal('flip' in template.layout,false);assert.equal(cleanLayout(first.layout).flip,sourceFlip);
    const result=applyTemplate(second,template);
    assert.equal(result.layout.flip,targetFlip);assert.equal(result.layout.clock.rows.time.x,.88);
  }
});

test('组件标签与自定义文字可保存；旧模板缺少的组件保留草稿值',()=>{
  const draft=defaultDraft();draft.layout.clock.rows.steps={visible:true,x:.45,y:.88,size:28,align:'left',label:false,language:'zh'};
  const text='今天开心🌻'.repeat(12);draft.layout.clock.rows.text={visible:true,x:.7,y:.2,size:31,align:'right',text,language:'zh'};
  draft.appearance.fonts.steps='/字体.ttf';draft.appearance.colors.steps='#88aa99';
  const result=applyTemplate(draft,{layout:{scale:1.2,x:.3,y:.6,rows:{time:{visible:true,x:.9,y:.4,size:80,align:'right'}}}});
  assert.deepEqual(result.layout.clock.rows.steps,draft.layout.clock.rows.steps);
  assert.equal(result.layout.clock.rows.text.text,[...text].slice(0,40).join(''));assert.equal([...result.layout.clock.rows.text.text].length,40);
  assert.deepEqual(result.appearance,draft.appearance);assert.equal(draft.layout.clock.rows.text.text,text);
  const template=makeTemplate('组件排版',result.layout);
  assert.equal(template.layout.rows.steps.label,false);assert.equal(template.layout.rows.text.text,result.layout.clock.rows.text.text);
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
  }finally{await fs.rm(base,{recursive:true,force:true});}
});
