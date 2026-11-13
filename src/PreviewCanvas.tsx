import { useEffect, useRef, useState } from 'react';
import type { ClockRow, Device, Draft, Layout, Preview, RowKey, SceneLayer } from './types';
import timevariants from '../desktop/timevariants.cjs';
import widgets from '../core/组件绘制.cjs';
import definitions from '../core/组件.json';
const weightAt: (points: number[][], minute: number) => number = timevariants.weightAt;
const rowParts: (row:ClockRow, values:Record<string,number>)=>{w:number;parts:{file:string;x:number;w:number}[]} = widgets.rowParts;
const samples=Object.fromEntries(Object.entries(definitions.fields).filter(([,field])=>'sample' in field).map(([key,field])=>[key,(field as {sample:number}).sample]));

/** live 存在时为完整画面模式：画布透明，只绘制时钟与辅助线，并把取景位置同步给下方的实时渲染层 */
type Props = { preview: Preview|null; draft: Draft; device: Device; poster: string; playing: boolean; tilt: boolean; mask: boolean;
  selected: RowKey|null; onSelect:(key:RowKey|null)=>void; onLayout:(layout:Layout)=>void; onReady:()=>void;onError:(message:string)=>void;
  live?: { ready: boolean };
  /** 预览一天中的这一分钟；未指定时跟随当前时间 */
  minute?: number|null };
type Box = { key:RowKey; x:number; y:number; w:number; h:number };
const clamp=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value));

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
    circle(r*.918,'#080b0d');circle(r*.884,'#293136');circle(r*.865,'#060a0d');
    const glass=ctx.createRadialGradient(-r*.18,-r*.22,0,0,0,r*.85);
    glass.addColorStop(0,'#14262e');glass.addColorStop(.32,'#08151b');glass.addColorStop(.68,'#071015');glass.addColorStop(.88,'#121c22');glass.addColorStop(1,'#020405');circle(r*.85,glass);
    for(const [ratio,color] of [[.79,'#303a3f'],[.754,'#0b1014'],[.67,'#202d34'],[.626,'#03080c'],[.49,'#15232a'],[.455,'#03070a']] as const){ctx.beginPath();ctx.arc(0,0,r*ratio,0,Math.PI*2);ctx.strokeStyle=color;ctx.lineWidth=ratio===.754?3:1.1;ctx.stroke();}
    circle(r*.41,'#020608');
    ctx.save();ctx.beginPath();ctx.arc(0,0,r*.84,0,Math.PI*2);ctx.clip();
    const coat=ctx.createRadialGradient(-r*.27,-r*.29,0,-r*.27,-r*.29,r*.75);
    coat.addColorStop(0,'rgba(129,177,189,.18)');coat.addColorStop(.42,'rgba(65,118,133,.07)');coat.addColorStop(1,'rgba(49,83,95,0)');circle(r*.85,coat);
    ctx.beginPath();ctx.ellipse(-r*.32,-r*.40,r*.095,r*.035,-Math.PI/5,0,Math.PI*2);ctx.fillStyle='rgba(227,240,242,.48)';ctx.fill();
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

export function PreviewCanvas(props:Props) {
  const canvas=useRef<HTMLCanvasElement>(null);
  const current=useRef(props);current.current=props;
  const graphics=useRef(new Map<string,HTMLImageElement>()),glyphs=useRef(new Map<string,HTMLImageElement>());
  const boxes=useRef<Box[]>([]),pointer=useRef({x:0,y:0}),elapsed=useRef(0),motion=useRef({x:0,y:0});
  const drag=useRef<{key:RowKey|'scene';x:number;y:number;layout:Layout}|null>(null);
  const [ready,setReady]=useState(false);
  const videos=useRef(new Map<string|number,HTMLVideoElement>()),loadedRoot=useRef(''),paintedRoot=useRef('');
  const maskCache=useRef<{id:string;image:HTMLCanvasElement}|null>(null);
  const videoKey=JSON.stringify(props.preview?.layers.filter(l=>l.videoSource).map(l=>[l.id,l.videoSource]));
  useEffect(()=>{
    const elements=new Map<string|number,HTMLVideoElement>();
    for(const layer of props.preview?.layers||[]){
      if(!layer.videoSource)continue;
      const element=document.createElement('video');element.muted=true;element.loop=true;element.preload='auto';element.src=layer.videoSource;
      element.playbackRate=Number(current.current.draft.properties.__videoSpeed??1)/(current.current.preview?.videoSpeed||1);
      if(current.current.playing)void element.play().catch(()=>{});elements.set(layer.id,element);
    }
    videos.current=elements;
    return()=>{for(const element of elements.values()){element.pause();element.removeAttribute('src');element.load();}elements.clear();};
  },[videoKey]);
  useEffect(()=>{for(const element of videos.current.values()){element.playbackRate=Number(props.draft.properties.__videoSpeed??1)/(props.preview?.videoSpeed||1);if(props.playing)void element.play().catch(()=>{});else element.pause();}},[props.playing,props.draft.properties.__videoSpeed,props.preview?.videoSpeed]);
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
      const {draft,preview,onLayout}=current.current;if(!preview)return;
      event.preventDefault();
      const layout=structuredClone(draft.layout);
      const delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?node.clientHeight:1);
      layout.scale=clamp(layout.scale*Math.exp(-delta*.0015),.2,3);
      onLayout(layout);
    };
    node.addEventListener('wheel',wheel,{passive:false});return()=>node.removeEventListener('wheel',wheel);
  },[]);
  useEffect(()=>{
    let token=0,last=0,lastPaint=0;
    function draw(now:number){
      token=requestAnimationFrame(draw);
      const {preview,draft,device,playing,tilt,mask,selected}=current.current;
      const node=canvas.current,ctx=node?.getContext('2d');
      if(!preview||!node||!ctx)return;
      const live=current.current.live;
      const delta=last?Math.min(now-last,100):0;last=now;
      if(playing)elapsed.current+=delta;
      if(now-lastPaint<1000/Math.max(15,draft.motion.fps))return;const paintDelta=Math.min(100,now-lastPaint);lastPaint=now;
      if(node.width!==device.width)node.width=device.width;if(node.height!==device.height)node.height=device.height;
      const width=node.width,height=node.height;
      ctx.clearRect(0,0,width,height);if(!live){ctx.fillStyle=preview.background??'#111b2b';ctx.fillRect(0,0,width,height);}
      const maximum=Math.max(1,...preview.layers.map(l=>l.motion));
      const ax=draft.motion.amount*maximum,ay=ax*draft.motion.vertical;
      const scale=Math.max(width*(1+2*ax)/preview.width,height*(1+2*ay)/preview.height)*draft.layout.scale;
      const left=Math.min(-width*ax,Math.max(width-preview.width*scale+width*ax,(width-preview.width*scale)*draft.layout.x));
      const top=Math.min(-height*ay,Math.max(height-preview.height*scale+height*ay,(height-preview.height*scale)*draft.layout.y));
      const target=tilt?pointer.current:{x:0,y:0};
      const smoothing=1-Math.pow(1-draft.motion.smoothing,paintDelta/(1000/draft.motion.fps));
      motion.current.x+=(target.x-motion.current.x)*smoothing;
      motion.current.y+=(target.y-motion.current.y)*smoothing;
      if(live){
        // 实时渲染层按同一取景公式定位；感应模式整幅位移，与导出的整幅视频一致。
        const frame=node.parentElement?.querySelector<HTMLElement>('[data-live-frame]');
        if(frame){
          const k=node.clientWidth/width,ox=motion.current.x*width*draft.motion.amount,oy=motion.current.y*height*draft.motion.amount*draft.motion.vertical;
          const transform=`translate(${((left+ox)*k).toFixed(1)}px,${((top+oy)*k).toFixed(1)}px) scaleX(${draft.layout.flip?-1:1})`;
          const box=`${(preview.width*scale*k).toFixed(1)}px ${(preview.height*scale*k).toFixed(1)}px ${transform}`;
          if(frame.dataset.box!==box){frame.dataset.box=box;frame.style.width=(preview.width*scale*k).toFixed(1)+'px';frame.style.height=(preview.height*scale*k).toFixed(1)+'px';frame.style.transform=transform;}
        }
      }
      const clock=new Date(),minute=current.current.minute??clock.getHours()*60+clock.getMinutes()+clock.getSeconds()/60;
      for(const layer of live?[]:preview.layers){
        const video=videos.current.get(layer.id);
        const image=video&&video.readyState>=2?video:graphics.current.get(frameFile(layer,elapsed.current,draft.layout.flip?-motion.current.x:motion.current.x))||graphics.current.get(layer.asset);
        if(!image)continue;
        const offset=layer.travel?.length?sample(layer.travel,elapsed.current):[0,0];
        const alpha=(layer.fade?.length?sample(layer.fade,elapsed.current)[0]/255:1)*(layer.time?weightAt(layer.time,minute):1);
        if(alpha<=0)continue;
        ctx.save();ctx.globalAlpha=alpha;
        ctx.translate(left+(draft.layout.flip?preview.width-layer.x-offset[0]:layer.x+offset[0])*scale+motion.current.x*width*draft.motion.amount*layer.motion,
          top+(layer.y+offset[1])*scale+motion.current.y*height*draft.motion.amount*layer.motion*draft.motion.vertical);
        ctx.rotate((draft.layout.flip?-layer.rotation:layer.rotation)*Math.PI/180);
        if(draft.layout.flip)ctx.scale(-1,1);
        ctx.drawImage(image,-layer.w*scale/2,-layer.h*scale/2,layer.w*scale,layer.h*scale);
        ctx.restore();
      }
      boxes.current=[];
      if(preview.clock&&draft.layout.clock.enabled){
        const values=widgets.values(new Date(),samples);
        for(const row of preview.clock.rows){
          const setting=draft.layout.clock.rows[row.key];if(!setting.visible||row.sourceVisible===false)continue;
          const parts=rowParts(row,values),unit=Math.min(width/976,height/596)*setting.size/row.size;
          let x=setting.x*width;const y=setting.y*height;
          if(setting.align==='left')x+=parts.w*unit/2;if(setting.align==='right')x-=parts.w*unit/2;
          const paint=(file:string|undefined,px:number,w:number)=>{const image=file?glyphs.current.get(file):null;if(image)ctx.drawImage(image,px-w*unit/2,y-row.h*unit/2,w*unit,row.h*unit);};
          for(const part of parts.parts)paint(part.file,x+part.x*unit,part.w);
          const box={key:row.key,x:x-parts.w*unit/2-9,y:y-row.h*unit/2-8,w:parts.w*unit+18,h:row.h*unit+16};boxes.current.push(box);
          if(selected===row.key&&!tilt){ctx.save();ctx.strokeStyle='rgba(255,255,255,.9)';ctx.lineWidth=1.5;ctx.setLineDash([5,4]);ctx.strokeRect(box.x,box.y,box.w,box.h);ctx.setLineDash([]);ctx.fillStyle='#ffffff';for(const dx of [0,box.w])for(const dy of [0,box.h]){ctx.beginPath();ctx.arc(box.x+dx,box.y+dy,3,0,Math.PI*2);ctx.fill();}ctx.restore();}
        }
      }
      if(mask){if(maskCache.current?.id!==device.id)maskCache.current={id:device.id,image:cameraMask(device)};ctx.drawImage(maskCache.current.image,0,0);}
      const readyKey=live?(live.ready?'live:'+preview.assetRoot:''):(loadedRoot.current===preview.assetRoot?preview.assetRoot:'');
      if(readyKey&&paintedRoot.current!==readyKey){
        paintedRoot.current=readyKey;node.dataset.sceneReady='true';node.dataset.readyAt=String(performance.now());node.dataset.layerCount=String(preview.layers.length);
        if(!live)current.current.onReady();
      }
      if(live&&!live.ready&&paintedRoot.current){paintedRoot.current='';node.dataset.sceneReady='false';}
    }
    token=requestAnimationFrame(draw);return ()=>cancelAnimationFrame(token);
  },[]);
  function coords(event:React.PointerEvent<HTMLCanvasElement>){const box=event.currentTarget.getBoundingClientRect();return{x:(event.clientX-box.left)/box.width,y:(event.clientY-box.top)/box.height};}
  return <canvas ref={canvas} width={props.device.width} height={props.device.height} data-testid="wallpaper-canvas"
    aria-label="壁纸预览，可滚轮缩放、拖动构图和组件位置" className={`wallpaper-canvas ${ready?'is-ready':''} ${props.tilt?'tilt-mode':''} ${props.live?'live':''}`}
    style={{backgroundImage:props.poster&&!props.live?`url("${props.poster}")`:undefined}}
    onPointerDown={event=>{
      if(props.tilt)return;
      const point=coords(event),x=point.x*props.device.width,y=point.y*props.device.height;
      const hit=[...boxes.current].reverse().find(b=>x>=b.x&&x<=b.x+b.w&&y>=b.y&&y<=b.y+b.h);
      props.onSelect(hit?.key||null);drag.current={key:hit?.key||'scene',...point,layout:structuredClone(props.draft.layout)};
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={event=>{
      const point=coords(event);pointer.current={x:(point.x-.5)*2,y:(point.y-.5)*2};
      const start=drag.current;if(!start)return;
      const layout=structuredClone(start.layout);
      if(start.key==='scene'){layout.x=clamp(start.layout.x-(point.x-start.x));layout.y=clamp(start.layout.y-(point.y-start.y));}
      else{layout.clock.rows[start.key].x=clamp(start.layout.clock.rows[start.key].x+point.x-start.x);layout.clock.rows[start.key].y=clamp(start.layout.clock.rows[start.key].y+point.y-start.y);}
      props.onLayout(layout);
    }}
    onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}} onPointerLeave={()=>{pointer.current={x:0,y:0};}}
  />;
}
