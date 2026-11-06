const test=require('node:test');
const assert=require('node:assert/strict');
const {evaluateScene}=require('../desktop/scenescript.cjs');

test('原主题脚本读取滑块和开关，并输出实际坐标与颜色',async()=>{
  const input={width:100,height:100,properties:{offset:{type:'slider',value:17},enabled:{type:'bool',value:false},tint:{type:'color',value:'0.1 0.2 0.3'}},scene:{objects:[
    {id:1,name:'背景',origin:{value:'10 20 0',script:'export function update(value){ return value.add(new Vec3(engine.userProperties.offset,0,0)); }'},visible:{value:true,script:'export function update(){ return engine.userProperties.enabled; }'},color:{value:'1 1 1',script:'export function update(){return engine.userProperties.tint;}'}},
  ]}};
  const result=await evaluateScene(input);assert.deepEqual(result.errors,[]);
  assert.equal(result.scene.objects[0].origin,'27 20 0');assert.equal(result.scene.objects[0].visible,false);assert.equal(result.scene.objects[0].color,'0.1 0.2 0.3');
  assert.equal(input.scene.objects[0].origin.value,'10 20 0');
});

test('脚本属性覆盖和内置数学模块保持原作者参数',async()=>{
  const result=await evaluateScene({width:100,height:100,properties:{},scene:{objects:[{id:1,alpha:{value:1,scriptproperties:{strength:.3},script:"import * as WEMath from 'WEMath'; export var scriptProperties=createScriptProperties().addSlider({name:'strength',value:.8}).finish(); export function update(value){return WEMath.clamp(scriptProperties.strength,0,1);}"}}]}});
  assert.equal(result.scene.objects[0].alpha,.3);assert.deepEqual(result.errors,[]);
});

test('脚本运行时不暴露主机进程、文件和网络，超时后返回原场景',async()=>{
  const result=await evaluateScene({width:100,height:100,properties:{},scene:{objects:[{id:1,text:{value:'',script:'export function update(){return [typeof process,typeof require,typeof fetch].join(",");}'}}]}});
  assert.equal(result.scene.objects[0].text,'undefined,undefined,undefined');
  const timeout=await evaluateScene({width:100,height:100,properties:{},scene:{objects:[{id:1,alpha:{value:1,script:'export function update(){while(true){} return 0;}'}}]}},{timeout:20});
  assert(timeout.errors.length>0);
});
