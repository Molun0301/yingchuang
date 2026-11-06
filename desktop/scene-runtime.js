// 仅在隔离的脚本解释器内部运行；不提供文件、网络或系统调用。
function resolveScene(input) {
  const scene=input.scene,definitions=input.properties||{},errors=[];
  class Vec2 {
    constructor(x=0,y=x){if(x&&typeof x==='object'){this.x=Number(x.x??x[0]??0);this.y=Number(x.y??x[1]??0);}else{this.x=Number(x);this.y=Number(y);}}
    copy(){return new this.constructor(this);}
    add(v){return new this.constructor(this.x+(v?.x??v),this.y+(v?.y??v));}
    subtract(v){return new this.constructor(this.x-(v?.x??v),this.y-(v?.y??v));}
    multiply(v){return new this.constructor(this.x*(v?.x??v),this.y*(v?.y??v));}
    divide(v){return new this.constructor(this.x/(v?.x??v),this.y/(v?.y??v));}
    length(){return Math.hypot(this.x,this.y);}
    normalize(){return this.divide(this.length()||1);}
    dot(v){return this.x*v.x+this.y*v.y;}
    toString(){return [this.x,this.y].join(' ');}
  }
  class Vec3 extends Vec2 {
    constructor(x=0,y=x,z=x){super(x,y);this.z=Number(x&&typeof x==='object'?(x.z??x[2]??0):z);}
    add(v){return new Vec3(this.x+(v?.x??v),this.y+(v?.y??v),this.z+(v?.z??v));}
    subtract(v){return new Vec3(this.x-(v?.x??v),this.y-(v?.y??v),this.z-(v?.z??v));}
    multiply(v){return new Vec3(this.x*(v?.x??v),this.y*(v?.y??v),this.z*(v?.z??v));}
    divide(v){return new Vec3(this.x/(v?.x??v),this.y/(v?.y??v),this.z/(v?.z??v));}
    length(){return Math.hypot(this.x,this.y,this.z);}
    dot(v){return this.x*v.x+this.y*v.y+this.z*v.z;}
    cross(v){return new Vec3(this.y*v.z-this.z*v.y,this.z*v.x-this.x*v.z,this.x*v.y-this.y*v.x);}
    toString(){return [this.x,this.y,this.z].join(' ');}
  }
  function unpack(value,key='') {
    if(value&&typeof value==='object'&&!Array.isArray(value)&&'value'in value)value=value.value;
    if(key!=='text'&&typeof value==='string'&&/^\s*[-+\d.eE]+(?:\s+[-+\d.eE]+){1,2}\s*$/.test(value)){
      const numbers=value.trim().split(/\s+/).map(Number);if(numbers.every(Number.isFinite))return numbers.length===3?new Vec3(...numbers):new Vec2(...numbers);
    }
    return value;
  }
  function pack(value){if(value instanceof Vec2)return value.toString();return value;}
  const shared={},stored={};
  const localStorage={get:key=>stored[key],set:(key,value)=>{stored[key]=value;},remove:key=>delete stored[key]};
  const properties=Object.fromEntries(Object.entries(definitions).map(([key,p])=>[key,unpack(p.value,p.type==='color'?'color':'text')]));
  const engine={userProperties:properties,runtime:0,frametime:1/60,isMobile:false,screenResolution:new Vec2(input.width,input.height),canvasSize:new Vec2(input.width,input.height),language:'zh-cn'};
  const mouse={cursorPosition:new Vec2(input.width/2,input.height/2),cursorWorldPosition:new Vec3(input.width/2,input.height/2,0)};
  const inputState=mouse;
  const layers=new Map(),dirty=new Map();
  for(const raw of scene.objects||[]){
    const layer={};
    for(const key of new Set([...Object.keys(raw),'visible','origin','scale','angles','color','alpha','text','size'])){
      Object.defineProperty(layer,key,{enumerable:true,configurable:true,
        get:()=>unpack(dirty.has(raw.id+':'+key)?dirty.get(raw.id+':'+key).value:raw[key]??({visible:true,origin:'0 0 0',scale:'1 1 1',angles:'0 0 0',color:'1 1 1',alpha:1,text:'',size:'0 0'}[key]),key),
        set:value=>{dirty.set(raw.id+':'+key,{raw,key,value:pack(value)});}});
    }
    Object.defineProperty(layer,'getParent',{value:()=>layers.get(raw.parent)||null});
    Object.defineProperty(layer,'getTextureAnimation',{value:()=>({play(){},stop(){},pause(){},setFrame(){},getFrame(){return 0;}})});
    layers.set(raw.id,layer);
  }
  const thisScene={getLayer:key=>typeof key==='number'?layers.get(key):[...layers.values()].find(l=>l.name===key),getLayers:()=>[...layers.values()],getLayerCount:()=>layers.size,canvasSize:new Vec2(input.width,input.height)};
  const WEMath={...Object.fromEntries(Object.getOwnPropertyNames(Math).map(k=>[k,Math[k]])),
    clamp:(x,a,b)=>Math.max(a,Math.min(b,x)),mix:(a,b,t)=>a+(b-a)*t,lerp:(a,b,t)=>a+(b-a)*t,
    fract:x=>x-Math.floor(x),saturate:x=>Math.max(0,Math.min(1,x)),smoothStep:(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);},
    remap:(v,a,b,c,d)=>c+(v-a)/(b-a)*(d-c)};
  const WEVector={lerp:(a,b,t)=>a.add(b.subtract(a).multiply(t)),mix:(a,b,t)=>a.add(b.subtract(a).multiply(t))};
  const WEColor={rgbToHsv:c=>{const max=Math.max(c.x,c.y,c.z),min=Math.min(c.x,c.y,c.z),delta=max-min;let hue=0;if(delta)hue=(max===c.x?((c.y-c.z)/delta)%6:max===c.y?(c.z-c.x)/delta+2:(c.x-c.y)/delta+4)/6;return new Vec3((hue+1)%1,max?delta/max:0,max);},hsvToRgb:c=>{const k=n=>(n+c.x*6)%6;const f=n=>c.z-c.z*c.y*Math.max(0,Math.min(k(n),4-k(n),1));return new Vec3(f(5),f(3),f(1));}};
  const modules={WEMath,WEVector,WEColor};
  const scripts=[];
  function collect(value,path=[],layerId){
    if(!value||typeof value!=='object')return;
    if(typeof value.script==='string')scripts.push({binding:value,path,layerId});
    else for(const [key,child] of Object.entries(value))collect(child,[...path,key],layerId);
  }
  for(let i=0;i<(scene.objects||[]).length;i++)collect(scene.objects[i],['objects',String(i)],scene.objects[i].id);
  const prepared=[];
  for(const entry of scripts){
    const raw=entry.binding;const layer=layers.get(entry.layerId);const key=entry.path[entry.path.length-1];
    const overrides=raw.scriptproperties||{};
    function createScriptProperties(){const values={};const builder={finish:()=>Object.assign(values,Object.fromEntries(Object.entries(overrides).map(([k,v])=>[k,unpack(v)])))};for(const method of ['addCheckbox','addCheckBox','addSlider','addCombo','addText','addColor','addFile','addDirectory','addTexture','addVector2','addVector3'])builder[method]=spec=>{values[spec.name]=unpack(spec.value??spec.options?.[0]?.value??(method==='addCheckbox'?false:0));return builder;};return builder;}
    const console={log(){},warn(){},error(){}};
    const input=inputState;
    let source=raw.script.replace(/\bexport\s+(?=(?:let|const|var|function|class)\b)/g,'');
    source=source.replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"];?/g,(_m,name,module)=>`const ${name}=__modules[${JSON.stringify(module)}];`);
    source=source.replace(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"];?/g,(_m,names,module)=>`const {${names.replace(/\s+as\s+/g,':')}}=__modules[${JSON.stringify(module)}];`);
    try{
      const factory=new Function('thisLayer','thisObject','engine','thisScene','shared','localStorage','Vec2','Vec3','createScriptProperties','__modules','input','console',source+'\nreturn {init:typeof init==="function"?init:null,applyUserProperties:typeof applyUserProperties==="function"?applyUserProperties:null,update:typeof update==="function"?update:null};');
      const hooks=factory(layer,layer,engine,thisScene,shared,localStorage,Vec2,Vec3,createScriptProperties,modules,input,console);
      prepared.push({...entry,hooks,key,value:unpack(raw.value,key)});
    }catch(error){errors.push({layerId:entry.layerId,path:entry.path.join('.'),message:String(error.message).slice(0,160)});}
  }
  let completed=0;
  for(const item of prepared){
    try{const initialized=item.hooks.init?.(item.value);if(initialized!==undefined)item.value=initialized;item.hooks.applyUserProperties?.(properties);}
    catch(error){item.failed=true;errors.push({layerId:item.layerId,path:item.path.join('.'),message:String(error.message).slice(0,160)});}
  }
  for(const item of prepared){
    if(item.failed)continue;
    try{
      const value=item.hooks.update?item.hooks.update(item.value):item.value;
      if(value!==undefined){let target=scene;for(const part of item.path.slice(0,-1))target=target[part];target[item.key]=pack(value);}
      completed++;
    }catch(error){errors.push({layerId:item.layerId,path:item.path.join('.'),message:String(error.message).slice(0,160)});}
  }
  for(const {raw,key,value} of dirty.values())if(value!==undefined)raw[key]=value;
  const clockFormats={};
  for(const item of prepared){
    if(item.key==='text'&&typeof item.binding.scriptproperties?.use24hFormat==='boolean')clockFormats[item.layerId]=item.binding.scriptproperties.use24hFormat?'24':'12';
  }
  return {scene,errors,clockFormats,evaluated:completed,total:scripts.length};
}
