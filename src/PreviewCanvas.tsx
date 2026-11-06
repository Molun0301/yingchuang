import { useEffect, useRef, useState } from 'react';
import type { Device, Draft, Layout, Preview, RowKey, SceneLayer } from './types';

type Props = { preview: Preview|null; draft: Draft; device: Device; poster: string; playing: boolean; tilt: boolean; mask: boolean;
  selected: RowKey|null; onSelect:(key:RowKey|null)=>void; onLayout:(layout:Layout)=>void };
type Box = { key:RowKey; x:number; y:number; w:number; h:number };
const clamp=(value:number,min=0,max=1)=>Math.max(min,Math.min(max,value));
const roleName={week:'星期',date:'日期',time:'时间'};

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
  await Promise.all([...new Set(files)].map(file=>new Promise<void>(resolve=>{
    const img=new Image();img.onload=()=>{images.set(file,img);resolve();};img.onerror=()=>resolve();
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
  const video=useRef<HTMLVideoElement|null>(null);
  useEffect(()=>{
    if(!props.preview?.videoSource){video.current=null;return;}
    const element=document.createElement('video');element.muted=true;element.loop=true;element.preload='auto';element.src=props.preview.videoSource;video.current=element;
    if(props.playing)void element.play().catch(()=>{});
    return()=>{element.pause();element.removeAttribute('src');element.load();video.current=null;};
  },[props.preview?.videoSource]);
  useEffect(()=>{const element=video.current;if(!element)return;element.playbackRate=Number(props.draft.properties.__videoSpeed??1)/(props.preview?.videoSpeed||1);if(props.playing)void element.play().catch(()=>{});else element.pause();},[props.playing,props.draft.properties.__videoSpeed,props.preview?.videoSpeed]);
  useEffect(()=>{
    let cancelled=false;setReady(false);
    if(!props.preview){graphics.current.clear();return;}
    const files=props.preview.layers.flatMap(l=>[l.asset,...(l.sequence?.frames||[])]);
    void loadImages(props.preview.assetRoot,files).then(value=>{if(!cancelled){graphics.current=value;setReady(true);elapsed.current=0;}});
    return ()=>{cancelled=true;};
  },[props.preview?.assetRoot]);
  useEffect(()=>{
    let cancelled=false;
    if(!props.preview?.clock){glyphs.current.clear();return;}
    void loadImages(props.preview.clockRoot,props.preview.clock.assets).then(value=>{if(!cancelled)glyphs.current=value;});
    return ()=>{cancelled=true;};
  },[props.preview?.clockRoot]);
  useEffect(()=>{
    let token=0,last=0,lastPaint=0;
    function draw(now:number){
      token=requestAnimationFrame(draw);
      const {preview,draft,device,playing,tilt,mask,selected}=current.current;
      const node=canvas.current,ctx=node?.getContext('2d');
      if(!preview||!node||!ctx)return;
      const delta=last?Math.min(now-last,100):0;last=now;
      if(playing)elapsed.current+=delta;
      if(now-lastPaint<1000/Math.max(15,draft.motion.fps))return;const paintDelta=Math.min(100,now-lastPaint);lastPaint=now;
      if(node.width!==device.width)node.width=device.width;if(node.height!==device.height)node.height=device.height;
      const width=node.width,height=node.height;
      ctx.clearRect(0,0,width,height);ctx.fillStyle='#111b2b';ctx.fillRect(0,0,width,height);
      const maximum=Math.max(1,...preview.layers.map(l=>l.motion));
      const ax=draft.motion.amount*maximum,ay=ax*draft.motion.vertical;
      const scale=Math.max(width*(1+2*ax)/preview.width,height*(1+2*ay)/preview.height)*draft.layout.scale;
      const left=Math.min(-width*ax,Math.max(width-preview.width*scale+width*ax,(width-preview.width*scale)*draft.layout.x));
      const top=Math.min(-height*ay,Math.max(height-preview.height*scale+height*ay,(height-preview.height*scale)*draft.layout.y));
      const target=tilt?pointer.current:{x:0,y:0};
      const smoothing=1-Math.pow(1-draft.motion.smoothing,paintDelta/(1000/draft.motion.fps));
      motion.current.x+=(target.x-motion.current.x)*smoothing;
      motion.current.y+=(target.y-motion.current.y)*smoothing;
      for(const layer of preview.layers){
        const image=layer.video&&video.current&&video.current.readyState>=2?video.current:graphics.current.get(frameFile(layer,elapsed.current,motion.current.x));
        if(!image)continue;
        const offset=layer.travel?.length?sample(layer.travel,elapsed.current):[0,0];
        const alpha=layer.fade?.length?sample(layer.fade,elapsed.current)[0]/255:1;
        if(alpha<=0)continue;
        ctx.save();ctx.globalAlpha=alpha;
        ctx.translate(left+(layer.x+offset[0])*scale+motion.current.x*width*draft.motion.amount*layer.motion,
          top+(layer.y+offset[1])*scale+motion.current.y*height*draft.motion.amount*layer.motion*draft.motion.vertical);
        ctx.rotate(layer.rotation*Math.PI/180);ctx.drawImage(image,-layer.w*scale/2,-layer.h*scale/2,layer.w*scale,layer.h*scale);ctx.restore();
      }
      boxes.current=[];
      if(preview.clock&&draft.layout.clock.enabled){
        const date=new Date();
        const hourFormat=draft.layout.clock.format==='auto'?preview.clock.rows.find(r=>r.key==='time')?.hourFormat:draft.layout.clock.format;
        const digits:Record<string,number>={Y:date.getFullYear(),M:date.getMonth()+1,D:date.getDate(),h:hourFormat==='12'?(date.getHours()%12||12):date.getHours(),m:date.getMinutes(),s:date.getSeconds()};
        for(const row of preview.clock.rows){
          const setting=draft.layout.clock.rows[row.key];if(!setting.visible||row.sourceVisible===false)continue;
          const original=Number(preview.clock.fonts?.[roleName[row.key]]?.['字号'])||setting.size;
          const unit=Math.min(width/976,height/596)*setting.size/original;
          let x=setting.x*width;const y=setting.y*height;
          if(setting.align==='left')x+=row.w*unit/2;if(setting.align==='right')x-=row.w*unit/2;
          const paint=(file:string|undefined,px:number,w:number)=>{const image=file?glyphs.current.get(file):null;if(image)ctx.drawImage(image,px-w*unit/2,y-row.h*unit/2,w*unit,row.h*unit);};
          if(row.key==='week')paint(row.weekdays?.[date.getDay()],x,row.w);
          else for(const part of row.pieces||[]){const field=part.digit;const file=field?row.digits?.[Math.floor(digits[field[0]]/(10**Number(field[1])))%10]:part.asset;paint(file,x+part.x*unit,part.w);}
          const box={key:row.key,x:x-row.w*unit/2-9,y:y-row.h*unit/2-8,w:row.w*unit+18,h:row.h*unit+16};boxes.current.push(box);
          if(selected===row.key&&!tilt){ctx.save();ctx.strokeStyle='rgba(255,255,255,.9)';ctx.lineWidth=1.5;ctx.setLineDash([5,4]);ctx.strokeRect(box.x,box.y,box.w,box.h);ctx.setLineDash([]);ctx.fillStyle='#ffffff';for(const dx of [0,box.w])for(const dy of [0,box.h]){ctx.beginPath();ctx.arc(box.x+dx,box.y+dy,3,0,Math.PI*2);ctx.fill();}ctx.restore();}
        }
      }
      if(mask){ctx.fillStyle='rgba(14,21,31,.44)';ctx.fillRect(0,0,width*device.safeLeft,height);ctx.save();ctx.strokeStyle='rgba(255,255,255,.5)';ctx.setLineDash([6,6]);ctx.beginPath();ctx.moveTo(width*device.safeLeft,0);ctx.lineTo(width*device.safeLeft,height);ctx.stroke();ctx.restore();}
    }
    token=requestAnimationFrame(draw);return ()=>cancelAnimationFrame(token);
  },[]);
  function coords(event:React.PointerEvent<HTMLCanvasElement>){const box=event.currentTarget.getBoundingClientRect();return{x:(event.clientX-box.left)/box.width,y:(event.clientY-box.top)/box.height};}
  return <canvas ref={canvas} width={props.device.width} height={props.device.height} data-testid="wallpaper-canvas"
    aria-label="壁纸预览，可拖动构图和时间位置" className={`wallpaper-canvas ${ready?'is-ready':''} ${props.tilt?'tilt-mode':''}`}
    style={{backgroundImage:props.poster?`url("${props.poster}")`:undefined}}
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
