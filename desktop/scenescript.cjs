const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {newQuickJSWASMModuleFromVariant,shouldInterruptAfterDeadline}=require('quickjs-emscripten-core');
const variant=require('@jitl/quickjs-wasmfile-release-sync');
let modulePromise;
const getQuickJS=()=>modulePromise ||= newQuickJSWASMModuleFromVariant(variant);
const runtimeSource=fs.readFileSync(path.join(__dirname,'scene-runtime.js'),'utf8');

function scriptInput(detail,values){
  const input=structuredClone(detail);
  for(const [key,value]of Object.entries(values||{}))if(input.properties[key])input.properties[key].value=value;
  for(const definition of Object.values(input.properties)){
    const value=definition.value;
    if(['file','scenetexture'].includes(String(definition.type).toLowerCase())&&typeof value==='string'&&value&&fs.existsSync(value)){
      definition.value='user/'+createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,28)+path.extname(value).toLowerCase();
    }
  }
  function binding(value){
    if(Array.isArray(value))return value.map(binding);
    if(!value||typeof value!=='object')return value;
    const user=value.user;
    if(typeof user==='string'&&input.properties[user])return 'value'in input.properties[user]?input.properties[user].value:value.value;
    if(user&&typeof user==='object'&&input.properties[user.name])return String(input.properties[user.name].value)===String(user.condition);
    return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,binding(item)]));
  }
  input.scene=binding(input.scene);return input;
}

/** now：可选的模拟时刻（毫秒时间戳），脚本中的 Date 与 engine.timeOfDay 都按它计算 */
async function evaluateScene(input,{timeout=1500,now}={}){
  const QuickJS=await getQuickJS();
  const code=runtimeSource+'\nJSON.stringify(resolveScene('+JSON.stringify(now===undefined?input:{...input,now})+'));';
  try{
    return JSON.parse(QuickJS.evalCode(code,{shouldInterrupt:shouldInterruptAfterDeadline(Date.now()+timeout),memoryLimitBytes:96*1024*1024}));
  }catch(error){return{scene:input.scene,errors:[{message:String(error.message||error).slice(0,160)}],evaluated:0,total:0};}
}
/**
 * 同一份输入按多个时刻反复求值（一天内的时段采样）：脚本运行时与场景只载入一次，每次只解析场景副本并运行脚本。
 * 用完调用 dispose 释放解释器。
 */
async function sceneEvaluator(input,{timeout=1500}={}){
  const QuickJS=await getQuickJS();
  const runtime=QuickJS.newRuntime();runtime.setMemoryLimit(96*1024*1024);
  const vm=runtime.newContext();
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now()+timeout));
  vm.unwrapResult(vm.evalCode(runtimeSource+'\nglobalThis.__input='+JSON.stringify(JSON.stringify(input))+';')).dispose();
  return {
    evaluate(now){
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now()+timeout));
      const result=vm.evalCode('JSON.stringify(resolveScene({...JSON.parse(__input),now:'+Number(now)+'}))');
      if(result.error){const error=vm.dump(result.error);result.error.dispose();return{scene:input.scene,errors:[{message:String(error?.message||error).slice(0,160)}],evaluated:0,total:0};}
      const text=vm.getString(result.value);result.value.dispose();
      return JSON.parse(text);
    },
    dispose(){vm.dispose();runtime.dispose();},
  };
}
module.exports={evaluateScene,sceneEvaluator,scriptInput};
