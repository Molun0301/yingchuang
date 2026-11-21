import { useEffect, useRef, useState } from 'react';
import type { ClockRow, Device, Framing, Preview, Project, SceneLayer, SourceLayer, WidgetKey } from './types';
import timevariants from '../desktop/timevariants.cjs';
import widgets from '../core/组件绘制.cjs';
import definitions from '../core/组件.json';
const weightAt: (points: number[][], minute: number) => number = timevariants.weightAt;
const rowParts: (row:ClockRow, values:Record<string,number>)=>{w:number;parts:{file:string;x:number;w:number}[]} = widgets.rowParts;
const samples=Object.fromEntries(Object.entries(definitions.fields).filter(([,field])=>'sample' in field).map(([key,field])=>[key,(field as {sample:number}).sample]));

/** live 存在时画面来自实时渲染页：画布透明，只绘制组件与辅助线，并把取景位置同步给下方的渲染层 */
type Props = { preview: Preview|null; project: Project; device: Device; poster: string; playing: boolean; tilt: boolean; mask: boolean;
  /** 选中的组件，可多选（Shift 点选） */
  selection: WidgetKey[]; onSelect:(keys:WidgetKey[])=>void;
  /** 取景与组件位置的修改；key 相同的连续修改合成一步撤销 */
  onUpdate:(change:(project:Project)=>void,key:string)=>void; onReady:()=>void; onError:(message:string)=>void;
  /** layered：图层模式，渲染页按 motion（最大感应倍数）取景，倾斜时由 parallax 逐层移动，不整幅平移 */
  live?: { ready: boolean; layered?: boolean; motion?: number; parallax?: (x:number,y:number)=>void };
  /** 预览一天中的这一分钟；未指定时跟随当前时间。组件时钟也显示这一刻 */
  minute?: number|null;
  /** 图层页打开时：点击画面选中最上面的图层，并描出所选图层的范围 */
  layers?: { items: SourceLayer[]; selected: string; onPick:(id:string)=>void } };
type Box = { key:WidgetKey; x:number; y:number; w:number; h:number };
type Guide = { axis:'x'|'y'; at:number };
type CurveLayer = SceneLayer & { curve?: Partial<Record<'alpha'|'dx'|'dy'|'sx'|'sy'|'rot',number[][]>> };
const clamp=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value));
/** 吸附距离（机型像素） */
const SNAP=6;

/** 镜头以机型像素绘制并缓存；细金属圈、镜筒与微弱镀膜反光保持克制。 */
function cameraMask(device:Device):HTMLCanvasElement {
  const image=document.createElement('canvas');image.width=device.width;image.height=device.height;
  const ctx=image.getContext('2d')!,edge=device.width*device.safeLeft;
  ctx.fillStyle='rgba(10,16,21,.17)';ctx.fillRect(0,0,edge,device.height);
  ctx.strokeStyle='rgba(232,239,242,.4)';ctx.lineWidth=1;ctx.setLineDash([6,7]);ctx.beginPath();ctx.moveTo(edge,.5);ctx.lineTo(edge,device.height);ctx.stroke();ctx.setLineDash([]);
  const circle=(r:number,fill:string|CanvasGradient)=>{ctx.beginPath();ctx.arc(0,0,r,0,Math.PI*2);ctx.fillStyle=fill;ctx.fill();};
  const {x,ys,r}=device.camera;
  for(const y of ys){
    ctx.save();ctx.translate(x,y);
    ctx.shadowColor='rgba(0,0,0,.55)';ctx.shadowBlur=8;ctx.shadowOffsetY=2;circle(r+1,'#111619');ctx.shadowColor='transparent';
    const metal=ctx.createConicGradient(-Math.PI/2,0,0);
    for(const [at,color] of [[0,'#b7bec0'],[.07,'#4a5154'],[.19,'#171e22'],[.29,'#929b9e'],[.39,'#434b50'],[.51,'#c4cbcc'],[.60,'#596367'],[.73,'#1c2327'],[.84,'#9aa3a5'],[.93,'#515b60'],[1,'#b7bec0']] as const)metal.addColorStop(at,color);
    circle(r,metal);
    for(const ratio of [.988,.968,.948]){ctx.beginPath();ctx.arc(0,0,r*ratio,0,Math.PI*2);ctx.strokeStyle='rgba(236,244,245,.12)';ctx.lineWidth=.6;ctx.stroke();}
    // 比例按 17 Pro Max 三维模型：镜片约 0.71r，黑色镜圈到 0.89r，最外是金属环。
    circle(r*.89,'#080b0d');circle(r*.865,'#262e33');circle(r*.845,'#05090c');
    for(const [ratio,color] of [[.8,'#1c262c'],[.76,'#070c10']] as const){ctx.beginPath();ctx.arc(0,0,r*ratio,0,Math.PI*2);ctx.strokeStyle=color;ctx.lineWidth=1.2;ctx.stroke();}
    const glass=ctx.createRadialGradient(-r*.15,-r*.18,0,0,0,r*.71);
    glass.addColorStop(0,'#14262e');glass.addColorStop(.32,'#08151b');glass.addColorStop(.68,'#071015');glass.addColorStop(.88,'#121c22');glass.addColorStop(1,'#020405');circle(r*.71,glass);
    for(const [ratio,color] of [[.66,'#303a3f'],[.63,'#0b1014'],[.56,'#202d34'],[.52,'#03080c'],[.41,'#15232a'],[.38,'#03070a']] as const){ctx.beginPath();ctx.arc(0,0,r*ratio,0,Math.PI*2);ctx.strokeStyle=color;ctx.lineWidth=ratio===.63?2.6:1.1;ctx.stroke();}
    circle(r*.34,'#020608');
    ctx.save();ctx.beginPath();ctx.arc(0,0,r*.7,0,Math.PI*2);ctx.clip();
    const coat=ctx.createRadialGradient(-r*.225,-r*.24,0,-r*.225,-r*.24,r*.63);
    coat.addColorStop(0,'rgba(129,177,189,.18)');coat.addColorStop(.42,'rgba(65,118,133,.07)');coat.addColorStop(1,'rgba(49,83,95,0)');circle(r*.71,coat);
    ctx.beginPath();ctx.ellipse(-r*.27,-r*.33,r*.08,r*.03,-Math.PI/5,0,Math.PI*2);ctx.fillStyle='rgba(227,240,242,.48)';ctx.fill();
    ctx.restore();ctx.restore();
  }
  return image;
}

function sample(points:number[][],ms:number):number[] {
  if (!points.length)return [];
  const period=points[points.length-1][0] || 1;
  const at=ms%period;
  let i=1;while(i<points.length && points[i][0]<at)i++;
  const a=points[Math.max(0,i-1)],b=points[Math.min(points.length-1,i)];
  const f=b[0]===a[0]?0:(at-a[0])/(b[0]-a[0]);
  return a.slice(1).map((v,k)=>v+(b[k+1]-v)*f);
}
function frameFile(layer:SceneLayer,ms:number,tilt:number):string {
  const seq=layer.sequence;
  if(!seq?.frames.length)return layer.asset;
  if(seq.mode==='tilt')return seq.frames[Math.round((clamp(tilt,-1,1)+1)*(seq.frames.length-1)/2)];
  const at=ms%seq.period;
  if(seq.times?.length){let i=seq.times.length-1;while(i>0&&seq.times[i]>at)i--;return seq.frames[i]||seq.frames[0];}
  return seq.frames[Math.min(seq.frames.length-1,Math.floor(at/seq.period*seq.frames.length))];
}
async function loadImages(root:string,files:string[]):Promise<Map<string,HTMLImageElement>> {
  const images=new Map<string,HTMLImageElement>();
  await Promise.all([...new Set(files)].map(file=>new Promise<void>((resolve,reject)=>{
    const img=new Image();img.onload=()=>{images.set(file,img);resolve();};img.onerror=()=>reject(new Error('无法读取预览资源：'+file));
    img.src=root+file.split('/').map(encodeURIComponent).join('/');
  })));
  return images;
}


/** 预览时刻对应的日期：今天的这一分钟 */
function momentAt(minute:number|null|undefined):Date {
  const date=new Date();
  if(minute!==null&&minute!==undefined)date.setHours(Math.floor(minute/60),Math.round(minute%60),0,0);
  return date;
}
/** 拖动时把被拖组件的左、中、右边与上、中、下边吸到参考线上；返回修正后的位移与命中的参考线 */
function snap(box:Box,dx:number,dy:number,xs:number[],ys:number[]):{dx:number;dy:number;guides:Guide[]} {
  const guides:Guide[]=[];
  const best=(edges:number[],lines:number[])=>{let hit:{shift:number;at:number}|null=null;for(const edge of edges)for(const line of lines){const shift=line-edge;if(Math.abs(shift)<=SNAP&&(!hit||Math.abs(shift)<Math.abs(hit.shift)))hit={shift,at:line};}return hit;};
  const x=best([box.x+dx,box.x+box.w/2+dx,box.x+box.w+dx],xs);if(x){dx+=x.shift;guides.push({axis:'x',at:x.at});}
  const y=best([box.y+dy,box.y+box.h/2+dy,box.y+box.h+dy],ys);if(y){dy+=y.shift;guides.push({axis:'y',at:y.at});}
  return {dx,dy,guides};
}

export function PreviewCanvas(props:Props) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const current=useRef(props);current.current=props;
  const graphics=useRef(new Map<string,HTMLImageElement>()),glyphs=useRef(new Map<string,HTMLImageElement>());
  const boxes=useRef<Box[]>([]),pointer=useRef({x:0,y:0}),elapsed=useRef(0),motion=useRef({x:0,y:0}),guides=useRef<Guide[]>([]);
  const frame=useRef({left:0,top:0,scale:1});
  const drag=useRef<{kind:'scene'|'widgets'|'marquee';x:number;y:number;moved:boolean;framing:Framing;start:Record<string,{x:number;y:number}>;box?:Box}|null>(null);
  /** Shift 在空白处拖出的选框（机型像素） */
  const marquee=useRef<{x:number;y:number;w:number;h:number}|null>(null);
  const [ready,setReady]=useState(false);
  const videos=useRef(new Map<string|number,HTMLVideoElement>()),loadedRoot=useRef(''),paintedRoot=useRef('');
  const maskCache=useRef<{id:string;image:HTMLCanvasElement}|null>(null);
  const videoKey=JSON.stringify(props.preview?.layers.filter(l=>l.videoSource).map(l=>[l.id,l.videoSource]));
  const speed=Number(props.project.properties.__videoSpeed??1);
  useEffect(()=>{
    const elements=new Map<string|number,HTMLVideoElement>();
    for(const layer of props.preview?.layers||[]){
      if(!layer.videoSource)continue;
      const element=document.createElement('video');element.muted=true;element.loop=true;element.preload='auto';element.src=layer.videoSource;
      element.playbackRate=Number(current.current.project.properties.__videoSpeed??1)/(current.current.preview?.videoSpeed||1);
      if(current.current.playing)void element.play().catch(()=>{});elements.set(layer.id,element);
    }
    videos.current=elements;
    return()=>{for(const element of elements.values()){element.pause();element.removeAttribute('src');element.load();}elements.clear();};
  },[videoKey]);
  useEffect(()=>{for(const element of videos.current.values()){element.playbackRate=speed/(props.preview?.videoSpeed||1);if(props.playing)void element.play().catch(()=>{});else element.pause();}},[props.playing,speed,props.preview?.videoSpeed]);
  useEffect(()=>{
    let cancelled=false;setReady(false);
    loadedRoot.current='';paintedRoot.current='';if(canvas.current)canvas.current.dataset.sceneReady='false';
    if(!props.preview){graphics.current.clear();return;}
    const preview=props.preview;
    void loadImages(preview.assetRoot,preview.layers.map(l=>l.asset)).then(async value=>{
      if(cancelled)return;
      graphics.current=value;loadedRoot.current=preview.assetRoot;setReady(true);elapsed.current=0;
      const files=preview.layers.flatMap(l=>l.sequence?.frames||[]).filter(f=>!value.has(f));
      // 第一帧绘制后再解码余下动画帧，避免长动画阻塞编辑。
      for(let i=0;i<files.length&&!cancelled;i+=6){
        const batch=await loadImages(preview.assetRoot,files.slice(i,i+6));
        if(!cancelled)for(const [key,image]of batch)value.set(key,image);
      }
    }).catch(error=>{if(!cancelled)current.current.onError(error.message);});
    return ()=>{cancelled=true;};
  },[props.preview?.assetRoot]);
  useEffect(()=>{
    let cancelled=false;
    if(!props.preview?.clock){glyphs.current.clear();return;}
    void loadImages(props.preview.clockRoot,props.preview.clock.assets).then(value=>{if(!cancelled)glyphs.current=value;}).catch(error=>{if(!cancelled)current.current.onError(error.message);});
    return ()=>{cancelled=true;};
  },[props.preview?.clockRoot]);
  useEffect(()=>{
    const node=canvas.current;if(!node)return;
    const wheel=(event:WheelEvent)=>{
      if(!current.current.preview)return;
      event.preventDefault();
      const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?node.clientHeight:1);
      current.current.onUpdate(project=>{project.framing.scale=clamp(project.framing.scale*Math.exp(-delta*.0015),.2,3);},'zoom');
    };
    node.addEventListener('wheel',wheel,{passive:false});return()=>node.removeEventListener('wheel',wheel);
  },[]);
  useEffect(()=>{
    let token=0,last=0,lastPaint=0;
    function draw(now:number){
      token=requestAnimationFrame(draw);
      const {preview,project,device,playing,tilt,mask,selection,layers}=current.current;
      const node=canvas.current,ctx=node?.getContext('2d');
      if(!preview||!node||!ctx)return;
      const live=current.current.live;
      const delta=last?Math.min(now-last,100):0;last=now;
      if(playing)elapsed.current+=delta;
      if(now-lastPaint<1000/Math.max(15,project.motion.fps))return;const paintDelta=Math.min(100,now-lastPaint);lastPaint=now;
      if(node.width!==device.width)node.width=device.width;if(node.height!==device.height)node.height=device.height;
      const width=node.width,height=node.height,framing=project.framing;
      ctx.clearRect(0,0,width,height);if(!live){ctx.fillStyle=preview.background??'#111b2b';ctx.fillRect(0,0,width,height);}
      const maximum=Math.max(1,live?.motion??1,...preview.layers.map(l=>l.motion));
      const ax=project.motion.amount*maximum,ay=ax*project.motion.vertical;
      const scale=Math.max(width*(1+2*ax)/preview.width,height*(1+2*ay)/preview.height)*framing.scale;
      const left=Math.min(-width*ax,Math.max(width-preview.width*scale+width*ax,(width-preview.width*scale)*framing.x));
      const top=Math.min(-height*ay,Math.max(height-preview.height*scale+height*ay,(height-preview.height*scale)*framing.y));
      frame.current={left,top,scale};
      const target=tilt?pointer.current:{x:0,y:0};
      const smoothing=1-Math.pow(1-project.motion.smoothing,paintDelta/(1000/project.motion.fps));
      motion.current.x+=(target.x-motion.current.x)*smoothing;
      motion.current.y+=(target.y-motion.current.y)*smoothing;
      if(live){
        // 实时渲染层按同一取景公式定位。录制模式整幅位移，与导出的整幅视频一致；
        // 图层模式把倍数为 1 的位移换算成场景单位交给渲染页逐层移动（画面水平翻转时场景内方向相反）。
        const liveFrame=node.parentElement?.querySelector<HTMLElement>('[data-live-frame]');
        const dx=motion.current.x*width*project.motion.amount,dy=motion.current.y*height*project.motion.amount*project.motion.vertical;
        if(live.layered)live.parallax?.((framing.flip?-dx:dx)/scale,dy/scale);
        if(liveFrame){
          const k=node.clientWidth/width,ox=live.layered?0:dx,oy=live.layered?0:dy;
          const transform=`translate(${((left+ox)*k).toFixed(1)}px,${((top+oy)*k).toFixed(1)}px) scaleX(${framing.flip?-1:1})`;
          const box=`${(preview.width*scale*k).toFixed(1)}px ${(preview.height*scale*k).toFixed(1)}px ${transform}`;
          if(liveFrame.dataset.box!==box){liveFrame.dataset.box=box;liveFrame.style.width=(preview.width*scale*k).toFixed(1)+'px';liveFrame.style.height=(preview.height*scale*k).toFixed(1)+'px';liveFrame.style.transform=transform;}
        }
      }
      const moment=momentAt(current.current.minute),minute=moment.getHours()*60+moment.getMinutes()+moment.getSeconds()/60;
      for(const layer of live?[]:preview.layers){
        const video=videos.current.get(layer.id);
        const image=video&&video.readyState>=2?video:graphics.current.get(frameFile(layer,elapsed.current,framing.flip?-motion.current.x:motion.current.x))||graphics.current.get(layer.asset);
        if(!image)continue;
        const curve=(layer as CurveLayer).curve;
        const at=(key:keyof NonNullable<CurveLayer['curve']>,value:number)=>curve?.[key]?weightAt(curve[key],minute):value;
        const offset=layer.travel?.length?sample(layer.travel,elapsed.current):[0,0];
        const alpha=(layer.fade?.length?sample(layer.fade,elapsed.current)[0]/255:1)*(layer.time?weightAt(layer.time,minute):1)*at('alpha',1);
        if(alpha<=0)continue;
        ctx.save();ctx.globalAlpha=alpha;
        const x=layer.x+offset[0]+at('dx',0),y=layer.y+offset[1]+at('dy',0),rotation=layer.rotation+at('rot',0);
        ctx.translate(left+(framing.flip?preview.width-x:x)*scale+motion.current.x*width*project.motion.amount*layer.motion,
          top+y*scale+motion.current.y*height*project.motion.amount*layer.motion*project.motion.vertical);
        ctx.rotate((framing.flip?-rotation:rotation)*Math.PI/180);
        if(framing.flip)ctx.scale(-1,1);
        // 平移已经定位图片中心，曲线缩放与旋转均绕该中心进行。
        ctx.scale(at('sx',1),at('sy',1));
        ctx.drawImage(image,-layer.w*scale/2,-layer.h*scale/2,layer.w*scale,layer.h*scale);
        ctx.restore();
      }
      if(layers?.selected&&!tilt){
        const box=layerBox(layers.items.find(item=>item.id===layers.selected),preview,framing.flip);
        if(box){ctx.save();ctx.strokeStyle='rgba(92,139,255,.95)';ctx.lineWidth=2;ctx.setLineDash([7,5]);ctx.strokeRect(box.x,box.y,box.w,box.h);ctx.restore();}
      }
      boxes.current=[];
      if(preview.clock&&project.showWidgets){
        const values=widgets.values(moment,samples);
        for(const row of preview.clock.rows){
          const setting=project.widgets.find(item=>item.key===row.key);if(!setting||row.sourceVisible===false)continue;
          const parts=rowParts({...row,language:setting.language},values),unit=Math.min(width/976,height/596)*setting.size/row.size,pad=row.pad||0;
          let x=setting.x*width;const y=setting.y*height;
          if(setting.align==='left')x+=parts.w*unit/2;if(setting.align==='right')x-=parts.w*unit/2;
          const paint=(file:string|undefined,px:number,w:number)=>{const image=file?glyphs.current.get(file):null;if(image)ctx.drawImage(image,px-(w/2+pad)*unit,y-(row.h/2+pad)*unit,(w+2*pad)*unit,(row.h+2*pad)*unit);};
          for(const part of parts.parts)paint(part.file,x+part.x*unit,part.w);
          const box={key:row.key,x:x-parts.w*unit/2,y:y-row.h*unit/2,w:parts.w*unit,h:row.h*unit};boxes.current.push(box);
          if(selection.includes(row.key)&&!tilt&&!layers){ctx.save();ctx.strokeStyle='rgba(255,255,255,.9)';ctx.lineWidth=1.5;ctx.setLineDash([5,4]);ctx.strokeRect(box.x-9,box.y-8,box.w+18,box.h+16);ctx.setLineDash([]);ctx.fillStyle='#ffffff';for(const dx of [-9,box.w+9])for(const dy of [-8,box.h+8]){ctx.beginPath();ctx.arc(box.x+dx,box.y+dy,3,0,Math.PI*2);ctx.fill();}ctx.restore();}
        }
      }
      if(mask){if(maskCache.current?.id!==device.id)maskCache.current={id:device.id,image:cameraMask(device)};ctx.drawImage(maskCache.current.image,0,0);}
      if(marquee.current){const m=marquee.current;ctx.save();ctx.fillStyle='rgba(92,139,255,.14)';ctx.strokeStyle='rgba(92,139,255,.95)';ctx.lineWidth=1.2;ctx.fillRect(m.x,m.y,m.w,m.h);ctx.strokeRect(m.x,m.y,m.w,m.h);ctx.restore();}
      if(drag.current?.kind==='widgets'&&guides.current.length){
        ctx.save();ctx.strokeStyle='rgba(255,79,163,.95)';ctx.lineWidth=1.2;
        for(const guide of guides.current){ctx.beginPath();if(guide.axis==='x'){ctx.moveTo(guide.at,0);ctx.lineTo(guide.at,height);}else{ctx.moveTo(0,guide.at);ctx.lineTo(width,guide.at);}ctx.stroke();}
        ctx.restore();
      }
      const readyKey=live?(live.ready?'live:'+preview.assetRoot:''):(loadedRoot.current===preview.assetRoot?preview.assetRoot:'');
      if(readyKey&&paintedRoot.current!==readyKey){
        paintedRoot.current=readyKey;node.dataset.sceneReady='true';node.dataset.readyAt=String(performance.now());node.dataset.layerCount=String(preview.layers.length);
        if(!live)current.current.onReady();
      }
      if(live&&!live.ready&&paintedRoot.current){paintedRoot.current='';node.dataset.sceneReady='false';}
    }
    token=requestAnimationFrame(draw);return ()=>cancelAnimationFrame(token);
  },[]);
  /** 场景内的图层范围（0～1，左上为原点）换算到机型像素 */
  function layerBox(layer:SourceLayer|undefined,preview:Preview,flip:boolean){
    if(!layer?.box)return null;
    const {left,top,scale}=frame.current,[x0,y0,x1,y1]=layer.box;
    const a=(flip?1-x1:x0)*preview.width*scale+left,b=(flip?1-x0:x1)*preview.width*scale+left;
    return {x:a,y:y0*preview.height*scale+top,w:b-a,h:(y1-y0)*preview.height*scale};
  }
  /** 点到的最上层图层；几乎铺满画面的背景层只在别处都没点中时才选 */
  function pickLayer(x:number,y:number){
    const {preview,project,layers,device}=current.current;if(!preview||!layers)return;
    const hits=layers.items.filter(item=>(project.layers[item.id]?.visible??item.visible)!==false).map(item=>({item,box:layerBox(item,preview,project.framing.flip)}))
      .filter(({box})=>box&&x>=box.x&&x<=box.x+box.w&&y>=box.y&&y<=box.y+box.h).reverse();
    const area=device.width*device.height,hit=hits.find(({box})=>box!.w*box!.h<area*.9)||hits[0];
    if(hit)layers.onPick(hit.item.id);
  }
  function coords(event:React.PointerEvent<HTMLCanvasElement>){const box=event.currentTarget.getBoundingClientRect();return{x:(event.clientX-box.left)/box.width,y:(event.clientY-box.top)/box.height};}
  return <canvas ref={canvas} width={props.device.width} height={props.device.height} data-testid="wallpaper-canvas"
    aria-label="壁纸预览，可滚轮缩放、拖动构图和组件位置" className={`wallpaper-canvas ${ready?'is-ready':''} ${props.tilt?'tilt-mode':''} ${props.live?'live':''}`}
    style={{backgroundImage:props.poster&&!props.live?`url("${props.poster}")`:undefined}}
    onPointerDown={event=>{
      if(props.tilt)return;
      const point=coords(event),x=point.x*props.device.width,y=point.y*props.device.height;
      const hit=props.layers?undefined:[...boxes.current].reverse().find(b=>x>=b.x-9&&x<=b.x+b.w+9&&y>=b.y-8&&y<=b.y+b.h+8);
      const project=props.project;
      if(hit){
        let keys=props.selection.includes(hit.key)&&!event.shiftKey?props.selection:[hit.key];
        if(event.shiftKey)keys=props.selection.includes(hit.key)?props.selection.filter(key=>key!==hit.key):[...props.selection,hit.key];
        props.onSelect(keys);
        const start=Object.fromEntries(project.widgets.filter(item=>keys.includes(item.key)).map(item=>[item.key,{x:item.x,y:item.y}]));
        drag.current={kind:'widgets',...point,moved:false,framing:project.framing,start,box:hit};
      }else{
        if(!props.layers&&!event.shiftKey)props.onSelect([]);
        drag.current={kind:!props.layers&&event.shiftKey?'marquee':'scene',...point,moved:false,framing:project.framing,start:{}};
      }
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event=>{
      const point=coords(event);pointer.current={x:(point.x-.5)*2,y:(point.y-.5)*2};
      const start=drag.current;if(!start)return;
      const {device,project}=props;
      if(!start.moved&&Math.hypot((point.x-start.x)*device.width,(point.y-start.y)*device.height)<3)return;
      start.moved=true;
      if(start.kind==='marquee'){
        const x0=Math.min(start.x,point.x)*device.width,y0=Math.min(start.y,point.y)*device.height;
        marquee.current={x:x0,y:y0,w:Math.abs(point.x-start.x)*device.width,h:Math.abs(point.y-start.y)*device.height};
        return;
      }
      if(start.kind==='scene'){
        props.onUpdate(value=>{value.framing.x=clamp(start.framing.x-(point.x-start.x));value.framing.y=clamp(start.framing.y-(point.y-start.y));},'framing');
        return;
      }
      // 只拿没在拖动的组件和画面中线、镜头线作参考；按住 Alt 暂停吸附。
      const others=boxes.current.filter(box=>!(box.key in start.start));
      const xs=[device.width/2,device.width*device.safeLeft,...others.flatMap(box=>[box.x,box.x+box.w/2,box.x+box.w])];
      const ys=[device.height/2,...others.flatMap(box=>[box.y,box.y+box.h/2,box.y+box.h])];
      let dx=(point.x-start.x)*device.width,dy=(point.y-start.y)*device.height;
      if(!event.altKey&&start.box){const result=snap(start.box,dx,dy,xs,ys);dx=result.dx;dy=result.dy;guides.current=result.guides;}else guides.current=[];
      props.onUpdate(value=>{for(const item of value.widgets){const origin=start.start[item.key];if(origin){item.x=clamp(origin.x+dx/device.width);item.y=clamp(origin.y+dy/device.height);}}},'widgets');
    }}
    onPointerUp={event=>{
      const start=drag.current;drag.current=null;guides.current=[];
      const m=marquee.current;marquee.current=null;
      if(start?.kind==='marquee'&&m){const hits=boxes.current.filter(box=>box.x<m.x+m.w&&box.x+box.w>m.x&&box.y<m.y+m.h&&box.y+box.h>m.y).map(box=>box.key);props.onSelect([...new Set([...props.selection,...hits])]);}
      if(start&&!start.moved&&start.kind==='scene'&&props.layers){const point=coords(event);pickLayer(point.x*props.device.width,point.y*props.device.height);}
    }}
    onPointerCancel={()=>{drag.current=null;guides.current=[];marquee.current=null;}} onPointerLeave={()=>{pointer.current={x:0,y:0};}}
  />;
}
