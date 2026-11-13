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
  const draft=defaultDraft();draft.layout.clock.rows.steps={visible:true,x:.45,y:.88,size:28,align:'left',label:false};
  const text='今天开心🌻'.repeat(12);draft.layout.clock.rows.text={visible:true,x:.7,y:.2,size:31,align:'right',text};
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

test('时段变化：瞬间切换按分钟定位，渐变按线性过渡，持续变化的对象排除，叠加后权重不出现空档',async()=>{
  const {planTimeVariants,weightAt}=require('../desktop/timevariants.cjs');
  // a：8:20–17:00 显示白天贴图，其余显示夜晚；b：9:36–12:00 透明度渐变；c：每分钟都变（时钟类）
  const evaluate=async minute=>({objects:[
    {id:1,name:'a',image:minute>=500&&minute<1020?'day':'night'},
    {id:2,name:'b',alpha:Math.round(Math.min(1,Math.max(0,(minute-576)/144))*100)/100},
    {id:3,name:'c',text:String(minute)},{id:4,name:'不变',image:'x'}]});
  const plan=await planTimeVariants(evaluate,new Set([99]));
  assert.deepEqual(Object.keys(plan.objects).sort(),['1','2']);assert(plan.notes.some(note=>note.includes('c')));
  const a=plan.objects['1'];assert.equal(a.length,2);
  const day=a.find(v=>plan.scenes[v.scene].objects[0].image==='day'),night=a.find(v=>v!==day);
  for(const [minute,expectDay] of [[499,0],[501,1],[1019,1],[1021,0],[0,0],[720,1]]){
    assert.equal(Math.round(weightAt(day.alpha,minute)),expectDay,`白天 ${minute}`);
    // 下层变体在切换后保持不透明，上层叠加，合成画面不出现透明空档
    assert(Math.max(weightAt(day.alpha,minute),weightAt(night.alpha,minute))>.99,`空档 ${minute}`);
  }
  const b=plan.objects['2'];assert.equal(b.length,2);
  const full=b.find(v=>plan.scenes[v.scene].objects[1].alpha===1),none=b.find(v=>v!==full);
  // 渐变期间上层权重按线性变化，下层保持 1
  const upper=b.indexOf(full)>b.indexOf(none)?full:none;
  const mid=weightAt(upper.alpha,(570+720)/2);assert(mid>.3&&mid<.7,`渐变中点 ${mid}`);
});
