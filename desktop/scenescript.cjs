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

async function evaluateScene(input,{timeout=1500}={}){
  const QuickJS=await getQuickJS();
  const code=runtimeSource+'\nJSON.stringify(resolveScene('+JSON.stringify(input)+'));';
  try{
    return JSON.parse(QuickJS.evalCode(code,{shouldInterrupt:shouldInterruptAfterDeadline(Date.now()+timeout),memoryLimitBytes:96*1024*1024}));
  }catch(error){return{scene:input.scene,errors:[{message:String(error.message||error).slice(0,160)}],evaluated:0,total:0};}
}
module.exports={evaluateScene,scriptInput};
