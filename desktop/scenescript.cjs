const fs=require('node:fs');
const path=require('node:path');
const {getQuickJS,shouldInterruptAfterDeadline}=require('quickjs-emscripten');
const runtimeSource=fs.readFileSync(path.join(__dirname,'scene-runtime.js'),'utf8');

async function evaluateScene(input,{timeout=1500}={}){
  const QuickJS=await getQuickJS();
  const code=runtimeSource+'\nJSON.stringify(resolveScene('+JSON.stringify(input)+'));';
  try{
    return JSON.parse(QuickJS.evalCode(code,{shouldInterrupt:shouldInterruptAfterDeadline(Date.now()+timeout),memoryLimitBytes:96*1024*1024}));
  }catch(error){return{scene:input.scene,errors:[{message:String(error.message||error).slice(0,160)}],evaluated:0,total:0};}
}
module.exports={evaluateScene};
