const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { evaluateScene, sceneEvaluator, scriptInput, sceneState } = require('./scenescript.cjs');
const { frameScene, recordSize } = require('./framing.cjs');
const { planTimeVariants, localMinute } = require('./timevariants.cjs');
const { fullAvailable } = require('./library.cjs');
const { model } = require('./projects.cjs');

function createPipeline({ userData, workers, resources, liveTheme, recorder, desktopCapturer, currentDevice }) {
  const { runWorker: worker, stopWorker, trackProcess } = workers;
  const { assetRoot, fileUrl, rendererUrl, liveRoot } = resources;
  const { record, bake, observe, measureLuts } = recorder;
  const inspections = new Map(), scriptCache = new Map(), timeCache = new Map();
  let ffmpegPath;

  /** 默认图层模式；只有用户选择录制、或壁纸无法按图层转换时才录制完整画面 */
  async function exportMode(theme, project) {
    if (project.export?.mode === 'record' && fullAvailable(theme)) return 'record';
    if ((await inspect(theme)).renderable) return 'layers';
    return fullAvailable(theme) ? 'record' : 'layers';
  }

  function previewData(data) {
    return {...data,...('assetRoot'in data?{assetRoot:assetRoot(data.assetRoot)}:{}),...('clockRoot'in data?{clockRoot:assetRoot(data.clockRoot)}:{}),
      ...(data.layers?{layers:data.layers.map(layer=>({...layer,...(layer.videoSource||layer.video?{videoSource:fileUrl(layer.videoSource||path.join(data.assetRoot,layer.video))}:{})}))}:{})};
  }

  async function inspect(theme,device=currentDevice()) {
    if (!inspections.has(theme.id)) inspections.set(theme.id,worker({operation:'inspect',theme,project:model.create({properties:theme.propertyValues}),device}));
    const pending=inspections.get(theme.id);
    try { return await pending; }
    catch(error) { if(inspections.get(theme.id)===pending)inspections.delete(theme.id);throw error; }
  }
  async function withScripts(theme,project,signal) {
    if(theme.type!=='scene')return theme;
    const stat=await fs.stat(theme.source);
    const key=JSON.stringify([theme.id,stat.mtimeMs,stat.size,project.properties,Math.floor(Date.now()/60000)]);
    if(scriptCache.has(key))return{...theme,...scriptCache.get(key)};
    const detail=await inspect(theme);
    // 透视等原生图层无法解析的场景只走完整画面，脚本由渲染页自行执行。
    if(!detail.scriptInput)return theme;
    const input=scriptInput(detail.scriptInput,project.properties);
    if(signal?.aborted)throw new Error('已取消');
    const result=await evaluateScene(input);
    const graphicsScene={...result.scene,objects:result.scene.objects.filter(o=>!input.clockLayerIds.includes(o.id))};
    const value={resolvedScene:result.scene,scriptSignature:createHash('sha256').update(JSON.stringify(graphicsScene)).digest('hex'),scriptResult:{errors:result.errors,clockFormats:result.clockFormats||{},evaluated:result.evaluated,total:result.total}};
    scriptCache.set(key,value);if(scriptCache.size>12)scriptCache.delete(scriptCache.keys().next().value);
    return{...theme,...value};
  }
  /**
   * 按时间导出（实验开关）打开时，渲染器在一天中固定 8 个时刻观察，QuickJS 补上文字和特效参数并定位切换的分钟。
   * 结果按壁纸、设置与日期缓存；开关关闭或没有变化时返回 null。
   */
  async function timeVariantsFor(theme,project,signal) {
    if(theme.type!=='scene'||project.export?.timeVariation!==true)return null;
    const detail=await inspect(theme);
    if(!detail.scriptInput)return null;
    const clock=new Set(detail.scriptInput.clockLayerIds);
    const stat=await fs.stat(theme.source);
    const key=JSON.stringify([theme.id,stat.mtimeMs,stat.size,project.properties,project.layers,new Date().toDateString()]);
    if(!timeCache.has(key)){
      // 同一解释器反复按不同时刻求值，脚本运行时与场景只载入一次。
      timeCache.set(key,(async()=>{
        const evaluator=await sceneEvaluator(scriptInput(detail.scriptInput,project.properties));
        try{
          const job=await observationJob(theme,project,'observe');
          return await planTimeVariants(minute=>evaluator.evaluate(localMinute(minute)).scene,clock,{
            adjustLayerIds:detail.adjustLayerIds,daytimeLayerIds:detail.daytimeLayerIds,
            observe:next=>observe({job,rendererUrl:rendererUrl(),signal,next}),
          });
        }
        finally{evaluator.dispose();}
      })());
      if(timeCache.size>8)timeCache.delete(timeCache.keys().next().value);
    }
    try{return await timeCache.get(key);}catch(error){timeCache.delete(key);if(signal?.aborted)throw error;throw new Error('时段变化观察未完成：'+error.message+'。可在编辑器“导出”中改用录制模式。');}
  }
  /** 把各状态代表时刻的烘焙结果并入时段变体，交给转换进程 */
  function withBaked(variants,byScene,adjust) {
    const record=(id,{minute,...v},keys)=>({...v,baked:byScene[v.scene]?.[id]??null,...(keys?.length?{adjust:keys}:{})});
    return {scenes:variants.scenes,
      objects:Object.fromEntries(Object.entries(variants.objects).map(([id,list])=>[id,list.map((v,i)=>record(id,v,adjust.layers[`${id}_t${i}`]))])),
      curves:Object.fromEntries(Object.entries(variants.curves).map(([id,v])=>[id,record(id,v,adjust.layers[id])]))};
  }
  /** 只查对象自身字段中的脚本，时间来源与观察触发条件一致。 */
  function scriptReadsTime(value) {
    return value&&typeof value==='object'&&(/engine\.timeOfDay|new Date|Date\.now|getHours|getMinutes/.test(value.script||'')||Object.values(value).some(scriptReadsTime));
  }
  /** 观察与查色表测量使用同样的小画布，并保留完整场景供控制脚本运行。 */
  async function observationJob(theme,project,mode) {
    const [sceneWidth,sceneHeight]=(await inspect(theme)).sourceSize;
    const full={width:320,height:Math.round(320*sceneHeight/sceneWidth)},patch=await livePatch(theme,project);
    patch.transparent=false;
    return {theme:liveTheme(theme),properties:project.properties,patch,playing:true,dpr:1,mode,fps:30,warmup:0,frames:0,
      sceneWidth,sceneHeight,full,crop:{x:0,y:0,...full}};
  }
  /** 完整画面打开前的场景覆盖：隐藏原时钟文字层，图层编辑与用户字体映射到渲染页可读的地址 */
  async function livePatch(theme,project,device=currentDevice()) {
    const detail=await inspect(theme,device);
    const layers={},fonts={};
    for(const [id,edit] of Object.entries(project.layers||{})){
      const copy={...edit};
      if(typeof copy.font==='string'&&copy.font&&!copy.font.startsWith('theme:')){
        const name='yingchuang-font/'+createHash('sha256').update(copy.font).digest('hex').slice(0,16)+path.extname(copy.font).toLowerCase();
        fonts[name]=liveRoot(path.dirname(copy.font))+encodeURIComponent(path.basename(copy.font));copy.font=name;
      }
      layers[id]=copy;
    }
    return {hidden:detail.clockLayerIds||[],layers,fonts};
  }
  async function recordTheme(input,signal,progress) {
    const {theme,project,device}=input;
    if(theme.type==='application')return recordApplication(input,signal,progress);
    const detail=await inspect(theme);
    const [sceneWidth,sceneHeight]=theme.type==='scene'&&detail.sourceSize?detail.sourceSize:[1920,1080];
    const settings=project.export;
    const framing=frameScene(sceneWidth,sceneHeight,device.width,device.height,project.framing,project.motion.amount,project.motion.vertical);
    const size=recordSize(device.width,device.height,framing);
    const full={width:Math.ceil(sceneWidth*framing.scale),height:Math.ceil(sceneHeight*framing.scale)};
    const crop={...size,x:Math.round(-device.width*framing.marginX-framing.left),y:Math.round(-device.height*framing.marginY-framing.top)};
    crop.x=Math.max(0,Math.min(crop.x,full.width-crop.width));crop.y=Math.max(0,Math.min(crop.y,full.height-crop.height));
    if(project.framing.flip)crop.x=full.width-crop.x-crop.width;
    const fade=settings.loop?Math.round(settings.fade*settings.fps):0;
    const job={theme:liveTheme(theme),properties:project.properties,patch:await livePatch(theme,project),playing:true,dpr:1,
      mode:theme.type==='scene'?'step':'realtime',fps:settings.fps,frames:Math.round(settings.duration*settings.fps)+fade,fade,
      warmup:Math.round(2*settings.fps),sceneWidth,sceneHeight,full,crop,flip:project.framing.flip};
    ffmpegPath ||= (await worker({operation:'ffmpeg'})).path;
    const output=path.join(userData,'jobs','record-'+randomUUID()+'.mp4');
    progress({phase:'载入完整画面',progress:6});
    return record({job,output,ffmpeg:ffmpegPath,rendererUrl:rendererUrl(),signal,
      onProgress:share=>progress({phase:'录制完整画面',progress:Math.round(8+share*72)})});
  }
  // 逐层烘焙：每秒十五帧观察最多十二秒，检出周期后独立定时；未检出时沿用四秒与半秒淡化。
  // version 随烘焙算法变化递增，使旧缓存失效。
  // 十二秒观察为最长十一秒的候选留出至少一秒复核；完整帧缓存仍只有四秒加淡化。
  const BAKE={fps:15,seconds:4,maxSeconds:12,fade:.5,warmup:1,version:11};
  /**
   * 逐层烘焙。不随时段变化的图层按当前时刻渲染；随时段变化的图层在各状态的代表时刻分别渲染。
   * 返回 {baked, byScene}：byScene[场景下标][对象编号] 为该时段变体的烘焙记录。
   */
  async function bakeLayers(theme,project,device,signal,progress,variants) {
    const varying=new Set([...Object.keys(variants?.objects||{}),...Object.keys(variants?.curves||{})].map(Number));
    const scenes=varying.size?variants.scenes:[];
    // 当前时刻与各时段状态的规划在同一个转换进程里完成。
    const [plan,...scenePlans]=await worker({operation:'layer-plans',theme,project,device,varying:[...varying],scenes:[theme.resolvedScene??null,...scenes]},signal);
    const particles=list=>new Set(list.targets.filter(t=>t.kind==='particle').map(t=>t.id));
    // 合成层连同下方图层渲染成一层，下方图层不再单独输出。
    const members=Object.fromEntries(plan.targets.filter(t=>t.members).map(t=>[t.id,t.members]));
    const groups=[{targets:plan.targets.map(t=>t.id).filter(id=>!varying.has(id)),particles:particles(plan),members,resolved:theme.resolvedScene,adjust:plan.adjust}];
    scenePlans.forEach((scenePlan,index)=>{
      const ids=new Set([...Object.entries(variants.objects).filter(([,list])=>list.some(v=>v.scene===index)).map(([id])=>Number(id)),
        ...Object.entries(variants.curves).filter(([,curve])=>curve.scene===index).map(([id])=>Number(id))]);
      groups.push({scene:index,minute:variants.minutes[index],ids,targets:scenePlan.targets.map(t=>t.id).filter(id=>ids.has(id)),particles:particles(scenePlan),
        members:Object.fromEntries(scenePlan.targets.filter(t=>t.members).map(t=>[t.id,t.members])),resolved:scenes[index],adjust:scenePlan.adjust});
    });
    const adjust={luts:{},layers:{},hidden:[]},tasks=[],measurements=[],states=new Map();
    const base=await observationJob(theme,project,'lut'),detail=await inspect(theme);
    const original=new Map(detail.scriptInput.scene.objects.map(object=>[object.id,object])),daytime=new Set(detail.daytimeLayerIds);
    for(const group of groups){
      const order=new Map(group.resolved.objects.map((object,i)=>[object.id,i]));
      const objects=new Map(group.resolved.objects.map(object=>[object.id,object])),targets=[],taskKey=`lut@${group.minute??'now'}`;
      group.adjust.sort((a,b)=>order.get(a.id)-order.get(b.id));
      for(const layer of group.adjust){
        const below=layer.below.filter(id=>group.ids?group.ids.has(id):!varying.has(id));
        if(!below.length)continue;
        const chain=[];
        for(let object=objects.get(layer.id);object;object=objects.get(object.parent))chain.push(object);
        const minute=daytime.has(layer.id)||scriptReadsTime(original.get(layer.id))?group.minute??'now':null;
        const signature=JSON.stringify([chain,minute]);
        if(!states.has(layer.id))states.set(layer.id,new Map());
        const layerStates=states.get(layer.id);
        if(!layerStates.has(signature)){
          layerStates.set(signature,{key:`${layer.id}@${layerStates.size}`,taskKey});
          targets.push(layer.id);
        }
        measurements.push({...layerStates.get(signature),group,layer,below});
      }
      if(targets.length){
        const patch={...base.patch,keep:targets,state:sceneState(detail.scriptInput.scene,group.resolved,targets)};
        tasks.push({key:taskKey,job:{...base,patch,minute:group.minute,lut:{size:9,targets}}});
      }
    }
    const measured=tasks.length?await measureLuts({tasks,rendererUrl:rendererUrl(),signal}):{};
    for(const {key,taskKey,group,layer,below}of measurements){
      const lut=measured[taskKey][layer.id];
      if(lut.positional){
        // 混合模式纯色层只盖住局部（如专辑卡片的阴影、边框），按普通图层逐层渲染；全屏后期层无法逐层还原，隐藏。
        if(layer.kind==='blend'){if((!group.ids||group.ids.has(layer.id))&&!group.targets.includes(layer.id))group.targets.push(layer.id);}
        else if(!adjust.hidden.includes(layer.id))adjust.hidden.push(layer.id);
        continue;
      }
      adjust.luts[key]={size:lut.size,table:lut.table};
      for(const id of below){
        const index=variants?.objects[id]?.findIndex(variant=>variant.scene===group.scene);
        const target=index!==undefined&&index>=0?`${id}_t${index}`:String(id);
        (adjust.layers[target]||=[]).push(key);
      }
    }
    // 某一时刻有位置相关效果时，整层都隐藏，避免其余时段残留半套调色。
    for(const [id,keys]of Object.entries(adjust.layers))adjust.layers[id]=keys.filter(key=>!adjust.hidden.includes(Number(key.split('@')[0])));
    for(const key of Object.keys(adjust.luts))if(adjust.hidden.includes(Number(key.split('@')[0])))delete adjust.luts[key];
    const prepared=await Promise.all(groups.filter(group=>group.targets.length).map(group=>cachedGroup(theme,project,device,group)));
    // 本次用到的烘焙目录在转换进程读完前不能被其他并行导出的清理删掉。
    const held=prepared.flatMap(entry=>Object.values(entry.dirs));holdBakes(held);
    try{
      // 多个调色变体共用同一份原始画面，本次导出也只烘焙一次。
      const shared=new Map();
      for(const entry of prepared){
        entry.missing=entry.missing.filter(id=>{
          const dir=entry.dirs[id];
          if(shared.has(dir))return false;
          shared.set(dir,{entry,id});return true;
        });
        entry.job.targets=entry.missing;
        entry.job.particles=entry.job.particles.filter(id=>entry.missing.includes(id));
      }
      const pending=prepared.filter(entry=>entry.missing.length);
      const total=prepared.reduce((sum,entry)=>sum+entry.group.targets.length,0),cached=total-pending.reduce((sum,entry)=>sum+entry.missing.length,0);
      if(pending.length){
        // 各时段状态缺少的图层一起分给多个窗口并行渲染，窗口数按处理器核数决定。
        const windows=Math.min(8,Math.max(2,Math.floor(os.cpus().length/4)));
        const results=await bake({tasks:pending.map(entry=>({job:entry.job,dirs:entry.dirs})),rendererUrl:rendererUrl(),signal,windows,onProgress:share=>progress((cached+share*(total-cached))/total)});
        await Promise.all(pending.map((entry,k)=>Promise.all(entry.missing.map(async id=>{
          entry.result[id]=results[k][id]||{empty:true};
          await fs.mkdir(entry.dirs[id],{recursive:true});await fs.writeFile(path.join(entry.dirs[id],'baked.json'),JSON.stringify(entry.result[id]));
        }))));
        await pruneBakes(new Set(prepared.flatMap(entry=>Object.values(entry.dirs))));
      }
      progress(1);
      const baked={},byScene={};
      for(const entry of prepared){
        for(const id of entry.group.targets){
          const source=shared.get(entry.dirs[id]);
          if(source)entry.result[id]=source.entry.result[source.id];
        }
        if(entry.group.minute===undefined)Object.assign(baked,entry.result);else byScene[entry.group.scene]=entry.result;
      }
      for(const list of Object.values(members))for(const id of list)baked[id]={empty:true};
      return {baked,byScene,adjust,release:()=>releaseBakes(held)};
    }catch(error){releaseBakes(held);throw error;}
  }
  /**
   * 按图层缓存的逐层烘焙：每层的缓存键是它求值后的内容（含上级图层、被引用的图层、图层编辑与取景尺寸），
   * 修改某项设置后只有内容变化的图层需要重新渲染。返回命中的结果与缺少图层的渲染任务。
   */
  async function cachedGroup(theme,project,device,group) {
    const detail=await inspect(theme),[sceneWidth,sceneHeight]=detail.sourceSize;
    const framing=frameScene(sceneWidth,sceneHeight,device.width,device.height,project.framing,project.motion.amount,project.motion.vertical);
    const full={width:Math.ceil(sceneWidth*framing.scale),height:Math.ceil(sceneHeight*framing.scale)};
    const patch=await livePatch(theme,project);patch.transparent=true;
    patch.state=sceneState(detail.scriptInput.scene,group.resolved,group.targets.flatMap(id=>[id,...(group.members[id]||[])]));
    const stat=await fs.stat(theme.source);
    const objects=new Map((group.resolved?.objects||[]).map(object=>[object.id,object]));
    const original=new Map(detail.scriptInput.scene.objects.map(object=>[object.id,object])),daytime=new Set(detail.daytimeLayerIds);
    const chain=id=>{const list=[];for(let object=objects.get(id);object&&list.length<32;object=objects.get(object.parent))list.push(object);return list;};
    // 效果引用的其他图层画面（_rt_imageLayerComposite_<编号>）也决定这一层的内容。
    const sources=ids=>{const found=new Set(),pending=[...ids];while(pending.length){const id=pending.pop();if(found.has(id)||!objects.has(id))continue;found.add(id);for(const match of JSON.stringify(objects.get(id).effects||[]).matchAll(/_rt_imageLayerComposite_(\d+)_/g))pending.push(Number(match[1]));}return [...found];};
    const bakes=path.join(userData,'cache','bakes');
    const dirs={},result={},missing=[];
    for(const id of group.targets){
      // 没有求值结果的场景（无脚本信息）退回按整套设置区分。
      const together=[id,...(group.members[id]||[])];
      const content=objects.size?sources(together).map(chain):project.properties;
      const minute=together.some(member=>chain(member).some(object=>daytime.has(object.id))||scriptReadsTime(original.get(member)))?group.minute:undefined;
      dirs[id]=path.join(bakes,createHash('sha256').update(JSON.stringify([theme.id,stat.mtimeMs,stat.size,full,BAKE,minute,content,together.map(member=>patch.layers[member]),patch.fonts])).digest('hex').slice(0,24));
      try{result[id]=JSON.parse(await fs.readFile(path.join(dirs[id],'baked.json'),'utf8'));await fs.utimes(dirs[id],new Date(),new Date());}
      catch{missing.push(id);}
    }
    const fade=Math.round(BAKE.fade*BAKE.fps);
    const job={theme:liveTheme(theme),properties:project.properties,patch,playing:true,dpr:1,mode:'bake',targets:missing,particles:missing.filter(id=>group.particles.has(id)),members:group.members,minute:group.minute,
      fps:BAKE.fps,probeFrames:Math.round(BAKE.maxSeconds*BAKE.fps)+1,frames:Math.round(BAKE.seconds*BAKE.fps)+fade,fade,warmup:Math.round(BAKE.warmup*BAKE.fps),sceneWidth,sceneHeight,full,
      crop:{x:0,y:0,width:full.width,height:full.height}};
    return {group,dirs,result,missing,job};
  }
  /** 原始帧较大，按最近使用保留约 1.5 GB；current 为本次用到的目录 */
  // 正在使用的烘焙目录（按引用计数）：从逐层渲染开始到转换进程读完为止，清理缓存时跳过。
  const bakesInUse=new Map();
  function holdBakes(dirs){for(const dir of dirs)bakesInUse.set(dir,(bakesInUse.get(dir)||0)+1);}
  function releaseBakes(dirs){for(const dir of dirs){const count=bakesInUse.get(dir)-1;if(count)bakesInUse.set(dir,count);else bakesInUse.delete(dir);}}
  async function pruneBakes(current) {
    const bakes=path.join(userData,'cache','bakes');
    const entries=await Promise.all((await fs.readdir(bakes)).map(async name=>{
      const folder=path.join(bakes,name);
      // 早期按整组保存的缓存（没有 baked.json）直接清除。
      const legacy=!(await fs.access(path.join(folder,'baked.json')).then(()=>true,()=>false));
      const size=await fs.stat(path.join(folder,'frames.rgba.gz')).then(info=>info.size,()=>0);
      return {folder,time:legacy?0:(await fs.stat(folder)).mtimeMs,size:legacy?Infinity:size};
    }));
    let kept=0;
    for(const entry of entries.sort((a,b)=>b.time-a.time)){kept+=entry.size;if(kept>1.5e9&&!current.has(entry.folder)&&!bakesInUse.has(entry.folder))await fs.rm(entry.folder,{recursive:true,force:true});}
  }
  /** 启动应用壁纸，找到它新开的窗口后实时采集画面；录制结束即结束整个进程树 */
  async function recordApplication(input,signal,progress) {
    const {theme,project,device}=input;
    if(!theme.available)throw new Error(theme.reason);
    const settings=project.export;
    const framing=frameScene(16,9,device.width,device.height,{scale:1,x:.5,y:.5},project.motion.amount,project.motion.vertical);
    const size=recordSize(device.width,device.height,framing);
    const before=new Set((await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:0,height:0}})).map(source=>source.id));
    progress({phase:'启动应用壁纸',progress:5});
    const child=spawn(theme.source,[],{cwd:theme.folder,detached:process.platform!=='win32',stdio:'ignore',windowsHide:false});
    trackProcess(child);
    let exited=false;child.on('exit',()=>{exited=true;});child.on('error',()=>{exited=true;});
    try{
      let source;
      for(const started=Date.now();!source;){
        if(signal?.aborted)throw new Error('已取消');
        if(exited)throw new Error('应用壁纸启动后立即退出。');
        if(Date.now()-started>30000)throw new Error('等待应用壁纸窗口超时。');
        await new Promise(resolve=>setTimeout(resolve,500));
        source=(await desktopCapturer.getSources({types:['window'],thumbnailSize:{width:0,height:0}})).find(item=>!before.has(item.id)&&item.name);
      }
      const fade=settings.loop?Math.round(settings.fade*settings.fps):0;
      const job={theme:liveTheme(theme),properties:{},patch:{hidden:[],layers:{},fonts:{}},playing:true,dpr:1,mode:'capture',sourceId:source.id,
        // 采集页按实际窗口尺寸求裁切，反向取景等价于 full.width - crop.x - crop.width。
        layout:{...project.framing,x:project.framing.flip?1-project.framing.x:project.framing.x},flip:project.framing.flip,margin:{x:framing.marginX,y:framing.marginY},fps:settings.fps,frames:Math.round(settings.duration*settings.fps)+fade,fade,
        warmup:Math.round(3*settings.fps),sceneWidth:16,sceneHeight:9,full:size,crop:{...size,x:0,y:0}};
      ffmpegPath ||= (await worker({operation:'ffmpeg'})).path;
      const output=path.join(userData,'jobs','record-'+randomUUID()+'.mp4');
      return await record({job,output,ffmpeg:ffmpegPath,rendererUrl:rendererUrl(),signal,
        onProgress:share=>progress({phase:'录制应用画面',progress:Math.round(8+share*72)})});
    }finally{stopWorker(child);}
  }
  async function exportWallpaper(input,signal,progress) {
    progress({phase:'读取壁纸设置',progress:3});
    if(input.mode==='record'){
      const recording=await recordTheme(input,signal,progress);
      try{return await worker({...input,operation:'export',recording},signal,event=>progress({...event,progress:Math.max(82,event.progress)}));}
      finally{await fs.rm(recording.path,{force:true});}
    }
    const theme=await withScripts(input.theme,input.project,signal);
    if(theme.type!=='scene')return worker({ ...input,theme,operation:'export' },signal,progress);
    progress({phase:'分析时段变化',progress:4});
    const timed=await timeVariantsFor(theme,input.project,signal);
    const {baked,byScene,adjust,release}=await bakeLayers(theme,input.project,input.device,signal,share=>progress({phase:'逐层渲染特效',progress:Math.round(5+share*45)}),timed)
      .catch(error=>{if(signal.aborted)throw error;throw new Error('逐层渲染未完成：'+error.message+'。可在编辑器“导出”中改用录制模式。');});
    try{return await worker({ ...input,theme,baked,adjust,notes:timed?.notes||[],...(timed?{timeVariants:withBaked(timed,byScene,adjust)}:{}),operation:'export' },signal,event=>progress({...event,progress:Math.max(52,event.progress)}));}
    finally{release();}
  }

  function clearCaches() { inspections.clear();scriptCache.clear();timeCache.clear(); }
  return { inspect, withScripts, livePatch, exportMode, exportWallpaper, previewData, clearCaches };
}

function createPreview({ pipeline, runWorker, projects, currentDevice, notify }) {
  let previewController, pendingMotion, prefetching;
  const { inspect, withScripts, previewData }=pipeline;

  function cancel() { pendingMotion=null;previewController?.abort(); }
  async function preview(theme, project, requestId) {
    cancel();
    const controller=previewController=new AbortController(),id=theme.id,device=currentDevice();
    // 同一壁纸的悬停预取结束后直接读预览缓存。
    if(prefetching?.id===id)await prefetching.done;
    const data=await runWorker({operation:'preview',theme,project,device},controller.signal,
      event=>notify('preview-progress',{id,...event}));
    if(controller.signal.aborted)throw new Error('已取消');
    if(data.progressive)pendingMotion={id,requestId,theme,project,device,controller};
    return previewData(data);
  }
  function motion(id, requestId) {
    const pending=pendingMotion;
    if(!pending||pending.id!==id||pending.requestId!==requestId||pending.controller.signal.aborted)return;
    pendingMotion=null;
    const {theme,project,device,controller}=pending;
    const live=()=>previewController===controller&&!controller.signal.aborted;
    void runWorker({operation:'motion-preview',theme,project,device},controller.signal,
      event=>{if(live())notify('preview-progress',{id,requestId,...event});})
      .then(data=>{if(live())notify('preview-ready',{id,requestId,data:previewData(data)});})
      .catch(error=>{if(live())notify('preview-ready',{id,requestId,error:error.message});});
  }
  function prefetch(theme) {
    prefetching?.controller.abort();
    if(!theme.available)return;
    const controller=new AbortController(),device=currentDevice();
    const done=(async()=>{
      const project=await projects.forTheme(theme);
      if(controller.signal.aborted)return;
      const detail=await inspect(theme,device);
      if(theme.type==='scene')await withScripts(theme,project,controller.signal);
      else if(detail.renderable)await runWorker({operation:'preview',theme,project,device},controller.signal);
    })().catch(()=>{});
    prefetching={id:theme.id,controller,done};
    return done;
  }
  async function clock(theme, project) {
    const device=currentDevice();
    return previewData(await runWorker({operation:'clock',theme:await withScripts(theme,project),project,device}));
  }
  return {preview,motion,prefetch,clock,cancel,close(){cancel();prefetching?.controller.abort();}};
}
module.exports = { createPipeline, createPreview };
