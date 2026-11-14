const test=require('node:test');
const assert=require('node:assert/strict');
const {planTimeVariants,weightAt,POINTS}=require('../desktop/timevariants.cjs');
const {sceneState}=require('../desktop/scenescript.cjs');

/** 用合成场景走观察的 next 协议；quickAt 给出 QuickJS 求值场景（缺省与渲染器相同）。 */
async function observePlan(sceneAt, options={}){
  const requests=[];
  const observe=async next=>{
    let request=await next(null);
    while(request){
      const previous=requests[requests.length-1];
      if(previous)assert(request.day*1440+request.minute>previous.day*1440+previous.minute);
      requests.push(request);
      const scene=sceneAt(request.minute);
      const byId=new Map(scene.objects.map(object=>[object.id,object]));
      const visible=object=>object.visible!==false&&(!byId.has(object.parent)||visible(byId.get(object.parent)));
      const vector=(value,defaultValue)=>Array.isArray(value)?value:String(value??defaultValue).split(' ').map(Number);
      request=await next({...request,layers:scene.objects.map(object=>({id:object.id,kind:'image',visible:object.visible!==false,effective:visible(object),alpha:object.alpha??1,
        color:vector(object.color,'1 1 1'),origin:vector(object.origin,'0 0 0'),scale:vector(object.scale,'1 1 1'),angles:vector(object.angles,'0 0 0'),brightness:object.brightness??1})),
        unstable:options.unstable?.(request)||{}});
    }
  };
  const quickAt=options.quickAt||sceneAt;
  const plan=await planTimeVariants(async minute=>quickAt(minute),new Set(),{...options,observe});
  return{plan,requests};
}
const scene=(...objects)=>({objects});
const endPoints=points=>{assert.equal(points[0][0],0);assert.equal(points.at(-1)[0],1440);};
const between=(minute,from,to)=>from<to?minute>=from&&minute<to:minute>=from||minute<to;

test('只在一天中固定的 8 个时刻观察，时钟递增；没有变化时不输出时段数据',async()=>{
  const {plan,requests}=await observePlan(()=>scene({id:1}));
  assert.deepEqual(requests.map(request=>request.minute),POINTS);
  assert.deepEqual(POINTS,[90,270,450,630,810,990,1170,1350]);
  assert.equal(plan,null);
});

test('QuickJS 看到一次跳变：在该分钟硬切换，曲线参考取可见时刻',async()=>{
  const {plan}=await observePlan(minute=>scene({id:1,visible:between(minute,1020,1200)}));
  const curve=plan.curves[1];endPoints(curve.alpha);
  assert.equal(curve.minute,1170);
  assert.equal(weightAt(curve.alpha,1019),0);assert.equal(weightAt(curve.alpha,1021),1);
  assert.equal(weightAt(curve.alpha,1199),1);assert.equal(weightAt(curve.alpha,1201),0);
});

test('QuickJS 看到区间内连续变化：在首末变化之间线性渐变',async()=>{
  const alpha=minute=>minute<=1000?1:minute>=1060?0:(1060-minute)/60;
  const {plan}=await observePlan(minute=>scene({id:1,alpha:between(minute,1000,1300)?alpha(minute):1}));
  const points=plan.curves[1].alpha;endPoints(points);
  assert.equal(weightAt(points,1000),1);assert(Math.abs(weightAt(points,1030)-.5)<.01);assert.equal(weightAt(points,1060),0);
});

test('QuickJS 看不到的可见性变化：在相邻观察时刻的中点硬切换',async()=>{
  const {plan}=await observePlan(minute=>scene({id:1,visible:minute===1170}),{quickAt:()=>scene({id:1,visible:false})});
  const points=plan.curves[1].alpha;
  assert.equal(weightAt(points,1079),0);assert.equal(weightAt(points,1081),1);
  assert.equal(weightAt(points,1259),1);assert.equal(weightAt(points,1261),0);
});

test('贴图在白天与夜晚之间切换：两份变体按切换分钟交替，代表时刻取各段中间的观察时刻',async()=>{
  const {plan}=await observePlan(minute=>scene({id:1,image:between(minute,480,1080)?'白天':'夜晚'}));
  const variants=plan.objects[1];
  assert.equal(variants.length,2);
  for(const variant of variants)endPoints(variant.alpha);
  const day=variants.find(variant=>between(variant.minute,480,1080)),night=variants.find(variant=>!between(variant.minute,480,1080));
  assert.equal(weightAt(day.alpha,600),1);assert.equal(weightAt(day.alpha,1100),0);
  assert.equal(weightAt(night.alpha,1100),1);
  // 下层变体在切换期间保持不透明，任何时刻叠加都不出现空档。
  for(const minute of [479,481,1079,1081])assert(Math.max(weightAt(day.alpha,minute),weightAt(night.alpha,minute))===1);
  assert.equal(plan.scenes.length,2);
});

test('持续位移只保留一份画面，位置按观察时刻分段线性',async()=>{
  const {plan}=await observePlan(minute=>scene({id:1,origin:`${minute} 0 0`}));
  const curve=plan.curves[1];
  assert(curve.origin);assert(!plan.objects[1]);
  for(const minute of POINTS)assert.equal(curve.origin.find(([at])=>at===minute)[1][0],minute);
});

test('区间内多次变化的文字按导出时刻固定；只跳变一次的文字照常生成变体',async()=>{
  const clock=await observePlan(minute=>scene({id:1,text:String(minute)}));
  assert.deepEqual(clock.plan.notes,['1 · 持续随时间变化，按导出时刻固定']);
  assert.deepEqual(clock.plan.objects,{});
  const label=await observePlan(minute=>scene({id:2,text:between(minute,360,1080)?'白天':'夜晚'}));
  assert.equal(label.plan.objects[2].length,2);
});

test('区间内跳变几次的时段文字：第二天补看每次跳变的分钟，每种状态都有画面且切换到分钟',async()=>{
  const label=minute=>minute<600?'甲':minute<660?'乙':minute<720?'丙':'丁';
  const {plan,requests}=await observePlan(minute=>scene({id:1,text:label(minute)}));
  assert.deepEqual(requests.filter(request=>request.day===1).map(request=>request.minute),[660]);
  const variants=plan.objects[1];
  assert.equal(variants.length,4);
  const visibleAt=minute=>variants.filter(variant=>weightAt(variant.alpha,minute)===1).map(variant=>label(variant.minute));
  assert.deepEqual(visibleAt(599).at(-1),'甲');assert.deepEqual(visibleAt(601).at(-1),'乙');
  assert.deepEqual(visibleAt(690).at(-1),'丙');assert.deepEqual(visibleAt(721).at(-1),'丁');
  assert.equal(plan.notes.length,0);
});

test('一分钟的切换过渡不当作时段：不补看，只保留前后两种状态并在过渡处渐变',async()=>{
  const weight=minute=>minute<239?0:minute<240?.6:1;
  const {plan,requests}=await observePlan(minute=>scene({id:1,effects:[{multiply:between(minute,240,600)?weight(minute):0}],image:'视频'}));
  assert.equal(requests.filter(request=>request.day===1).length,0);
  assert.equal(plan.objects[1].length,2);
});

test('着色器读取时刻的图层：8 个时刻各一份，相邻时刻之间渐变',async()=>{
  const {plan}=await observePlan(()=>scene({id:5},{id:6}),{daytimeLayerIds:[5]});
  assert.deepEqual(plan.objects[5].map(variant=>variant.minute),POINTS);
  assert(!plan.objects[6]);
  const weights=POINTS.map(minute=>weightAt(plan.objects[5][POINTS.indexOf(minute)].alpha,minute));
  assert(weights.every(weight=>weight===1));
});

test('调色层状态只影响绘制在它下方的图层',async()=>{
  const {plan}=await observePlan(minute=>scene({id:1},{id:9,visible:between(minute,1200,300)},{id:2}),{adjustLayerIds:[9]});
  assert.equal(plan.objects[1].length,2);
  assert(!plan.objects[2]&&!plan.curves[2]&&!plan.objects[9]&&!plan.curves[9]);
});

test('不稳定字段（时间轴晃动）不产生伪时段',async()=>{
  const {plan}=await observePlan(minute=>scene({id:1,origin:`${minute%7} 0 0`}),{unstable:()=>({1:['origin']}),quickAt:()=>scene({id:1})});
  assert.equal(plan,null);
});

test('状态写入只含目标、members 与上级，自身脚本和时间轴不固化，普通绑定可替换',()=>{
  const original=scene({id:10,origin:'5 0 0'},
    {id:1,parent:10,visible:{user:'开关',value:false},origin:{script:'自己移动',value:'0 0 0'},alpha:{animation:{},value:1},text:{value:'原文'}},
    {id:2,color:'1 1 1'},{id:3,visible:false});
  const resolved=scene({id:10,origin:'5 0 0',alpha:.5},{id:1,parent:10,visible:true,origin:'20 0 0',alpha:.7,text:'新文'},
    {id:2,color:'.5 .5 .5'},{id:3,visible:true});
  const state=sceneState(original,resolved,[1,2]);
  assert.deepEqual(state,{1:{visible:true,text:'新文'},2:{color:'.5 .5 .5'},10:{origin:'5 0 0',alpha:.5}});
});
