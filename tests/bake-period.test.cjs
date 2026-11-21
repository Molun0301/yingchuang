const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
// Windows 检出的源码是 CRLF 换行，下面的截取标记按 LF 写
const source=fs.readFileSync(require('node:path').join(__dirname,'../src/live/renderer.ts'),'utf8').replace(/\r\n/g,'\n');
const begin=source.indexOf('function changedPixels('),end=source.indexOf('/**\n * 逐层烘焙：同一场景实例',begin);
const code=ts.transpileModule(source.slice(begin,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const {bakeSignature,detectBakePeriod,bakeCandidates}=vm.runInNewContext(code+'\n({bakeSignature,detectBakePeriod,bakeCandidates})',{Float32Array,Uint8Array,Math});
const width=12,height=10,fps=15;
function frame(time,period){
 const data=new Uint8Array(width*height*4);
 for(let p=0;p<width*height;p++){
  const phase=time/period*Math.PI*2+p*.031;
  data.set([Math.round(128+100*Math.sin(phase)),Math.round(128+80*Math.cos(phase)),Math.round(128+60*Math.sin(phase*2)),255],p*4);
 }
 return data;
}
async function detect(render){
 const samples=Array.from({length:181},(_,i)=>bakeSignature(render(i/fps),width,height));
 return detectBakePeriod(samples,fps,width,height,async time=>render(time),4);
}
test('整数帧周期选择最短周期，不把二倍周期或单帧重合当成循环',async()=>{
 assert.equal(await detect(time=>frame(time,1.6)),1.6);
});
test('非整数帧周期细化到真实相位，调整帧率后恰好播放一周期',async()=>{
 const period=await detect(time=>frame(time,1.137));
 assert.equal(period,1.137);
 const count=Math.round(period*fps),rate=count/period;
 assert.equal(count,17);assert.notEqual(rate,fps);assert.equal(count/rate,period);
 assert.deepEqual(frame(count/rate,period),frame(0,period));
});
test('周期下限半秒与接近观察上限的周期也经过多相位验证',async()=>{
 assert.equal(await detect(time=>frame(time,.5)),.5);
 assert.equal(await detect(time=>frame(time,10.25)),10.25);
});
test('无周期和超长周期返回空值，交给原四秒交叉淡化路径',async()=>{
 assert.equal(await detect(time=>frame(time,45)),null);
 assert.equal(await detect(time=>{
  const data=new Uint8Array(width*height*4);let state=Math.round(time*100000)+1;
  for(let i=0;i<data.length;i++){state=(Math.imul(state,1664525)+1013904223)|0;data[i]=state>>>24;}
  return data;
 }),null);
});
test('仅首帧偶合不能通过多相位复核',async()=>{
 const render=time=>{
  const data=frame(time,1.2);
  if(time>5)for(let i=0;i<40;i++)data[i*4]=Math.floor(time*9)%255;
  return data;
 };
 assert.equal(await detect(render),null);
});
test('恒定特征没有动态周期',()=>{
 assert.equal(bakeCandidates(Array.from({length:181},()=>new Float32Array(4)),fps).length,0);
});

test('交互预览按每层独立周期和非等间隔时间点取帧',()=>{
 const html=fs.readFileSync(require('node:path').join(__dirname,'../core/预览模板.html'),'utf8');
 const start=html.indexOf('function layerImage('),end=html.indexOf('function drawClock(',start);
 const layerImage=vm.runInNewContext(html.slice(start,end)+';layerImage');
 const a={asset:'a0',sequence:{frames:['a0','a1','a2'],period:1137,times:[0,201,735]}};
 const b={asset:'b0',sequence:{frames:['b0','b1'],period:2413,times:[0,1207]}};
 assert.equal(layerImage(a,1136,0),'a2');assert.equal(layerImage(a,1137,0),'a0');
 assert.equal(layerImage(a,1137+201,0),'a1');assert.equal(layerImage(b,1137+201,0),'b1');
 assert.equal(layerImage(b,2413,0),'b0');
});
test('周期层零淡化写出完整一圈，回退层仍交叉淡化四秒',async()=>{
 const {LoopWriter}=require('../desktop/recorder.cjs');
 const periodic=[],fallback=[];
 const natural=new LoopWriter({write:async frame=>periodic.push(frame[0])},17,0);
 for(let i=0;i<17;i++)await natural.push(Buffer.from([i]));
 assert.deepEqual(periodic,Array.from({length:17},(_,i)=>i));assert(natural.complete);
 const old=new LoopWriter({write:async frame=>fallback.push(frame[0])},60,8);
 for(let i=0;i<68;i++)await old.push(Buffer.from([i]));
 assert.equal(fallback.length,60);assert(old.complete);
});

test('真实烘焙写流保留逐层帧数与小数帧率，并对回退层扣除淡化帧',async()=>{
 const fsp=require('node:fs/promises'),path=require('node:path'),zlib=require('node:zlib');
 const root=await fsp.mkdtemp(path.join(require('node:os').tmpdir(),'yc-period-writer-'));
 const recorderSource=fs.readFileSync(path.join(__dirname,'../desktop/recorder.cjs'),'utf8');
 const begin=recorderSource.indexOf('async function openBakeWindow('),end=recorderSource.indexOf('async function bake({',begin);
 const {LoopWriter}=require('../desktop/recorder.cjs'),active=new Map();
 const open=vm.runInNewContext(recorderSource.slice(begin,end)+';openBakeWindow',{
  fs:fsp,path,createGzip:zlib.createGzip,zlib:zlib.constants,createWriteStream:fs.createWriteStream,LoopWriter,active,
  setTimeout,clearTimeout,Buffer,recorderWindow:()=>({webContents:{id:1,on:()=>{}},isDestroyed:()=>false,destroy:()=>{},loadURL:async()=>{}}),
 });
 try{
  const dirs={1:path.join(root,'1'),2:path.join(root,'2')};
  const result=open({job:{targets:[1,2],fade:8,fps:15},dirs,rendererUrl:'test',onProgress:()=>{}}),task=active.get(1);
  await task.layer({id:1,width:1,height:1,count:17,fps:17/1.137,fade:0,period:1.137,bbox:[0,0,1,1]});
  for(let i=0;i<17;i++)await task.frame(new Uint8Array([i,i,i,255]));
  await task.layer({id:2,width:1,height:1,count:68,fps:15,fade:8,period:null,bbox:[0,0,1,1]});
  for(let i=0;i<68;i++)await task.frame(new Uint8Array([i,i,i,255]));
  await task.done();const records=await result;
  assert.equal(records[1].count,17);assert.equal(records[1].fps,17/1.137);assert.equal(records[1].period,1.137);
  assert.equal(records[2].count,60);assert.equal(records[2].fps,15);
  const data=zlib.gunzipSync(await fsp.readFile(path.join(dirs[1],'frames.rgba.gz')));
  assert.equal(data.length,17*4);assert.equal(data[0],0);assert.equal(data.at(-4),16);
  assert.equal(zlib.gunzipSync(await fsp.readFile(path.join(dirs[2],'frames.rgba.gz'))).length,60*4);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});

test('阶跃换帧的非整数周期保留最短一圈，不能误选更整齐的二倍周期',async()=>{
 for(const period of [1.1,1.137,1.7,2.5]){
  const render=time=>{
   const data=new Uint8Array(width*height*4),phase=Math.floor(((time%period)/period)*8);
   for(let i=0;i<width*height;i++)data.set([(phase*47+i*7)%255,(phase*83+i*13)%255,(phase*31+i*17)%255,255],i*4);
   return data;
  };
  assert.equal(await detect(render),period);
 }
});

test('小数周期细化后仍遵守半秒下限与复核时间范围',async()=>{
 assert.equal(await detect(time=>frame(time,.49)),.98);
 assert.equal(await detect(time=>frame(time,11.05)),null);
});
