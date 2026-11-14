const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {sceneState}=require('../desktop/scenescript.cjs');
const {frameScene}=require('../desktop/framing.cjs');

// 直接运行主进程的生产函数，用合成 worker/录制接口检查跨进程数据，不启动 Electron。
function mainFunctions(context){
  const source=fs.readFileSync(path.join(__dirname,'../desktop/main.cjs'),'utf8');
  const section=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const code=section('function withBaked(', '/** 观察与查色表')+
    section('async function bakeLayers(', '/**\n * 按图层缓存')+
    section('async function cachedGroup(', '/** 原始帧');
  return vm.runInNewContext(code+'\n({bakeLayers,cachedGroup,withBaked})',context);
}

test('主进程烘焙接线：曲线参考场景、合并成员状态、调色顺序与变体编号一致',async()=>{
  const original={objects:[{id:10,origin:'2 3 0'},{id:1,parent:10,visible:false},{id:11,parent:10,visible:false},
    {id:2,origin:{script:'自己移动',value:'0 0 0'},visible:false},{id:3,alpha:{animation:{},value:1}},
    {id:4},{id:20,parent:10,name:'颜色一'},{id:21,name:'位置滤镜'}]};
  const resolved=minute=>({objects:original.objects.map(object=>({...object,visible:true,origin:object.id===2?`${minute} 0 0`:object.origin,alpha:object.id===3?.8:1}))});
  const current=resolved(30),scenes=[resolved(0),resolved(720)];
  const variants={objects:{2:[{scene:0,minute:0,alpha:[[0,1],[1440,1]]},{scene:1,minute:720,alpha:[[0,0],[1440,0]]}]},
    curves:{3:{scene:1,minute:720,origin:[[0,[0,0,0]],[1440,[10,0,0]]]}},scenes,minutes:[0,720]};
  const adjustments=[{id:21,below:[1,2,3,4]},{id:20,below:[1,2,3,4]}];
  const plans=[{targets:[{id:1,members:[11]},{id:2},{id:3}],adjust:adjustments},
    {targets:[{id:2}],adjust:adjustments},{targets:[{id:2},{id:3}],adjust:adjustments}];
  let measurements,baking,planning;
  const functions=mainFunctions({path,createHash:require('node:crypto').createHash,sceneState,frameScene,BAKE:{fps:15,seconds:4,maxSeconds:12,fade:.5,warmup:1,version:10},
    app:{getPath:()=>'/测试缓存'},os:{cpus:()=>Array(8).fill({})},rendererUrl:()=>'/渲染页',liveTheme:()=>({key:'主题'}),
    inspect:async()=>({sourceSize:[100,80],scriptInput:{scene:original}}),
    livePatch:async()=>({hidden:[],layers:{},fonts:{}}),
    observationJob:async()=>({mode:'lut',patch:{hidden:[],transparent:false},full:{width:320,height:256}}),
    worker:async input=>{planning=input;return structuredClone(plans);},
    measureLuts:async({tasks})=>{measurements=tasks;return Object.fromEntries(tasks.map(task=>[task.key,Object.fromEntries(task.job.lut.targets.map(id=>[id,{size:9,table:[0,1,2],positional:id===21}]))]));},
    fs:{stat:async()=>({mtimeMs:0,size:10}),readFile:async()=>{throw Error('尚未缓存');},mkdir:async()=>{},writeFile:async()=>{}},
    bake:async({tasks})=>{baking=tasks;return tasks.map(task=>Object.fromEntries(task.job.targets.map(id=>[id,{dir:task.dirs[id],count:1}])));},
    pruneBakes:async()=>{},holdBakes:()=>{},releaseBakes:()=>{},
  });
  const output=await functions.bakeLayers({id:'主题',source:'scene.pkg',resolvedScene:current},{properties:{},layers:{},layout:{scale:1,x:.5,y:.5},motion:{amount:0,vertical:0}},
    {width:100,height:80},new AbortController().signal,()=>{},variants);
  assert.deepEqual(Array.from(planning.varying),[2,3]);
  assert.equal(measurements.length,1);assert.equal(measurements[0].key,'lut@now');
  const lut=measurements[0].job;
  assert.deepEqual(Array.from(lut.lut.targets),[20,21]);assert.equal(lut.lut.size,9);
  assert.deepEqual(Array.from(lut.patch.keep),[20,21]);assert.deepEqual(Object.keys(lut.patch.state).sort(),['10','20','21']);assert.equal(lut.minute,undefined);
  const now=baking.find(task=>task.job.minute===undefined).job;
  assert.equal(now.probeFrames,181);assert.equal(now.frames,68);
  assert.deepEqual(Object.keys(now.patch.state).sort(),['1','10','11']);assert.equal(now.patch.state[11].visible,true);
  const future=baking.find(task=>task.job.minute===720).job;
  assert(!('origin'in future.patch.state[2]));assert(!('alpha'in future.patch.state[3]));assert.equal(future.patch.state[2].visible,true);
  assert.deepEqual(Array.from(output.adjust.layers['2_t0']),['20@0']);assert.deepEqual(Array.from(output.adjust.layers['2_t1']),['20@0']);
  assert.deepEqual(Array.from(output.adjust.layers['3']),['20@0']);assert.deepEqual(Array.from(output.adjust.layers['4']),['20@0']);
  assert.deepEqual(Array.from(output.adjust.hidden),[21]);assert.equal('notes'in output,false);
  const data=functions.withBaked(variants,output.byScene,output.adjust);
  assert.equal(data.curves[3].baked.count,1);assert.deepEqual(Array.from(data.objects[2][1].adjust),['20@0']);
  assert.equal(output.baked[11].empty,true);
});

/** 运行真实主进程调度与缓存逻辑，内存文件系统记录本次导出的共享结果。 */
async function bakingCase({objects,sceneAt=()=>({objects}),minutes=[0,720],adjust=[],daytimeLayerIds=[],targets=[{id:1}]}){
  const original={objects},measurements=[],baking=[],files=new Map();
  const theme={id:'主题',source:'scene.pkg',resolvedScene:sceneAt(30)};
  const draft={properties:{},layers:{},layout:{scale:1,x:.5,y:.5},motion:{amount:0,vertical:0}},device={width:100,height:80};
  const variants={scenes:minutes.map(sceneAt),minutes,curves:{},objects:Object.fromEntries(targets.map(({id})=>[id,minutes.map((minute,scene)=>({minute,scene,alpha:[[0,1],[1440,1]]}))]))};
  const functions=mainFunctions({path,createHash:require('node:crypto').createHash,sceneState,frameScene,BAKE:{fps:15,seconds:4,maxSeconds:12,fade:.5,warmup:1,version:10},
    app:{getPath:()=>'/测试缓存'},os:{cpus:()=>Array(8).fill({})},rendererUrl:()=>'/渲染页',liveTheme:()=>({key:'主题'}),
    inspect:async()=>({sourceSize:[100,80],scriptInput:{scene:original},daytimeLayerIds}),
    livePatch:async()=>({hidden:[],layers:{},fonts:{}}),
    observationJob:async()=>({mode:'lut',patch:{hidden:[],transparent:false}}),
    worker:async()=>structuredClone(Array.from({length:minutes.length+1},()=>({targets,adjust}))),
    measureLuts:async({tasks})=>{
      measurements.push(...tasks);
      return Object.fromEntries(tasks.map(task=>[task.key,Object.fromEntries(task.job.lut.targets.map(id=>[id,{size:9,table:[id,task.job.minute,0],positional:false,inputError:0}]))]));
    },
    fs:{stat:async()=>({mtimeMs:0,size:10}),readFile:async file=>{if(!files.has(file))throw Error('尚未缓存');return files.get(file);},
      mkdir:async()=>{},writeFile:async(file,value)=>files.set(file,value),utimes:async()=>{}},
    bake:async({tasks})=>{baking.push(...tasks);return tasks.map(task=>Object.fromEntries(task.job.targets.map(id=>[id,{dir:task.dirs[id],count:1}])));},
    pruneBakes:async()=>{},holdBakes:()=>{},releaseBakes:()=>{},
  });
  const run=()=>functions.bakeLayers(theme,draft,device,new AbortController().signal,()=>{},variants);
  return {output:await run(),measurements,baking,files,run};
}

test('查色表按自身与上级的观察状态去重，同一分钟合并且保持绘制顺序',async()=>{
  const objects=[{id:10,origin:'0 0 0'},{id:11},{id:1,image:'背景'},
    {id:20,parent:10,color:'1 0 0'},{id:21,parent:11,color:'1 1 1'},{id:30,color:'0 0 0'}];
  const minutes=[0,360,720,1080];
  const sceneAt=minute=>({objects:objects.map(object=>({...object,
    ...(object.id===10?{origin:minute===720?'5 0 0':'0 0 0'}:{}),
    ...(object.id===20?{color:minute===360||minute===720?'0 0 1':'1 0 0'}:{}),
    ...(object.id===30?{color:`${minute} 0 0`}:{})}))});
  const {output,measurements,baking,files,run}=await bakingCase({objects,sceneAt,minutes,targets:[{id:1,kind:'particle'}],
    adjust:[{id:21,below:[1]},{id:20,below:[1]}]});
  assert.deepEqual(measurements.map(task=>[task.job.minute,Array.from(task.job.lut.targets)]),[[0,[20,21]],[360,[20]],[720,[20]]]);
  const first=measurements[0].job;
  assert.deepEqual(Array.from(first.patch.keep),[20,21]);assert.deepEqual(Object.keys(first.patch.state).sort(),['10','11','20','21']);
  assert.equal(measurements[2].job.patch.state[10].origin,'5 0 0');
  assert.deepEqual(Object.fromEntries(Object.entries(output.adjust.layers).map(([id,keys])=>[id,Array.from(keys)])),
    {'1_t0':['20@0','21@0'],'1_t1':['20@1','21@0'],'1_t2':['20@2','21@0'],'1_t3':['20@0','21@0']});
  assert.deepEqual(Array.from(output.adjust.luts['20@2'].table),[20,720,0]);
  assert.equal(baking.length,1);assert.deepEqual(Array.from(baking[0].job.targets),[1]);assert.deepEqual(Array.from(baking[0].job.particles),[1]);
  for(let i=1;i<minutes.length;i++)assert.equal(output.byScene[i][1],output.byScene[0][1]);
  assert.equal(files.size,1);
  const cached=await run();
  assert.equal(baking.length,1);assert.equal(cached.byScene[3][1].dir,output.byScene[0][1].dir);
});

test('查色表时间键只计自身着色器与自身脚本，上级状态相同及普通时间文字可复用',async()=>{
  for(const script of ['engine.timeOfDay','new Date()','Date.now()','clock.getHours()','clock.getMinutes()']){
    const objects=[{id:10,alpha:{value:1,script}},{id:11},{id:1,image:'背景'},
      {id:20,text:'Date.now getHours'}, {id:21,effects:[{amount:{value:1,script}}]},
      {id:22},{id:23,parent:10},{id:24,parent:11}];
    const sceneAt=()=>({objects:objects.map(object=>({...object,...(object.id===10?{alpha:1}:{}),...(object.id===21?{effects:[{amount:1}]}:{})}))});
    const {output,measurements}=await bakingCase({objects,sceneAt,daytimeLayerIds:[11,22],
      adjust:[20,21,22,23,24].map(id=>({id,below:[1]}))});
    assert.deepEqual(measurements.map(task=>[task.job.minute,Array.from(task.job.lut.targets)]),[[0,[20,21,22,23,24]],[720,[21,22]]],script);
    assert.deepEqual(Array.from(output.adjust.layers['1_t0']),['20@0','21@0','22@0','23@0','24@0']);
    assert.deepEqual(Array.from(output.adjust.layers['1_t1']),['20@0','21@1','22@1','23@0','24@0']);
  }
});

test('烘焙时间键：自身与上级着色器、自身脚本分时缓存，其余观察内容相同只烘焙一次',async()=>{
  const script='Date.now()';
  const cases=[
    {name:'观察内容相同',separate:false},
    {name:'自身着色器',daytimeLayerIds:[1],separate:true},
    {name:'上级着色器',daytimeLayerIds:[10],separate:true},
    {name:'祖先着色器',daytimeLayerIds:[11],separate:true},
    ...['engine.timeOfDay','new Date()','Date.now()','clock.getHours()','clock.getMinutes()'].map(script=>({name:script,ownScript:script,separate:true})),
    {name:'上级脚本但观察内容相同',parentScript:script,separate:false},
    {name:'普通字段包含时间字样',separate:false,text:'Date.now getMinutes'},
    {name:'观察内容改变',change:true,separate:true},
    {name:'合并成员着色器',daytimeLayerIds:[2],members:[2],separate:true},
    {name:'合并成员自身脚本',memberScript:script,members:[2],separate:true},
  ];
  for(const entry of cases){
    const objects=[{id:11},{id:10,parent:11,alpha:entry.parentScript?{value:1,script:entry.parentScript}:1},
      {id:1,parent:10,text:entry.text,alpha:entry.ownScript?{value:1,script:entry.ownScript}:1},
      {id:2,alpha:entry.memberScript?{value:1,script:entry.memberScript}:1}];
    const sceneAt=minute=>({objects:objects.map(object=>({...object,alpha:1,...(object.id===1&&entry.change?{color:minute<720?'1 0 0':'0 0 1'}:{})}))});
    const {output,baking}=await bakingCase({objects,sceneAt,daytimeLayerIds:entry.daytimeLayerIds,targets:[{id:1,members:entry.members}]});
    assert.equal(baking.length,entry.separate?2:1,entry.name);
    assert.equal(output.byScene[0][1].dir===output.byScene[1][1].dir,!entry.separate,entry.name);
  }
});

test('烘焙共用按层处理，同组中其他内容变化的图层继续独立渲染',async()=>{
  const objects=[{id:1,image:'背景'},{id:2,color:'1 0 0'}];
  const sceneAt=minute=>({objects:objects.map(object=>({...object,...(object.id===2?{color:minute<720?'1 0 0':'0 0 1'}:{})}))});
  const {output,baking}=await bakingCase({objects,sceneAt,targets:[{id:1,kind:'particle'},{id:2,kind:'particle'}]});
  assert.deepEqual(baking.map(task=>[task.job.minute,Array.from(task.job.targets),Array.from(task.job.particles)]),[[0,[1,2],[1,2]],[720,[2],[2]]]);
  assert.equal(output.byScene[0][1],output.byScene[1][1]);
  assert.notEqual(output.byScene[0][2].dir,output.byScene[1][2].dir);
});

/** 使用真实 QuickJS 与规划模块，只替换观察窗口入口，检查是否真的跳过渲染器。 */
function timeAnalysis(detail){
  const source=fs.readFileSync(path.join(__dirname,'../desktop/main.cjs'),'utf8');
  const code=source.slice(source.indexOf('async function timeVariantsFor('),source.indexOf('/** 把各状态代表时刻'));
  const {sceneEvaluator,scriptInput}=require('../desktop/scenescript.cjs');
  const {planTimeVariants,localMinute}=require('../desktop/timevariants.cjs');
  const evaluations=[],jobs=[],observations=[];
  const analyze=vm.runInNewContext(code+'\ntimeVariantsFor',{
    inspect:async()=>detail,fs:{stat:async()=>({mtimeMs:0,size:1})},timeCache:new Map(),
    sceneEvaluator:async input=>{
      const evaluator=await sceneEvaluator(input);
      return {evaluate:now=>{evaluations.push(now);return evaluator.evaluate(now);},dispose:()=>evaluator.dispose()};
    },scriptInput,planTimeVariants,localMinute,
    observationJob:async(...args)=>{jobs.push(args);return {mode:'observe'};},rendererUrl:()=>'/渲染页',
    observe:async({next})=>{observations.push(await next(null));throw Error('已启动观察');},
  });
  return {run:()=>analyze({type:'scene',id:'主题',source:'scene.pkg'},{properties:{},layers:{}},new AbortController().signal),evaluations,jobs,observations};
}

const scriptDetail=(objects,extra={})=>({scriptInput:{width:100,height:100,properties:{},clockLayerIds:[],scene:{objects}},...extra});
