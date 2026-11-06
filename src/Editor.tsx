import { Select } from './Select';
import { useEffect, useRef, useState } from 'react';
import { X, Play, Pause, MousePointer2, Move, RotateCcw, Save, SlidersHorizontal, Layers, LayoutTemplate, ChevronDown, Check, Type, AlignLeft, AlignCenter, AlignRight, Search, LoaderCircle, FolderOpen, Clock3 } from 'lucide-react';
import type { AppState, Draft, FontOption, Layout, Preview, RowKey, SourceLayer, Theme, ThemeDetail } from './types';
import { PreviewCanvas } from './PreviewCanvas';
import { ColorWell, PropertyControl, ResetButton, Slider, Toggle } from './controls';
import { colorHex, conditionVisible, sourceColor } from './conditions';
const rowNames:Record<RowKey,string>={week:'星期',date:'日期',time:'时间'};
const rows:RowKey[]=['week','date','time'];
const clockSignature=(draft:Draft)=>JSON.stringify([draft.appearance,draft.layout.clock.language,draft.layout.clock.seconds,draft.layout.clock.format,rows.map(k=>draft.layout.clock.rows[k].size),draft.deviceId]);

export function Editor({theme,state,onClose,onState,onConvert,onToast}:{theme:Theme;state:AppState;onClose:()=>void;onState:(v:Partial<AppState>)=>void;onConvert:()=>void;onToast:(s:string)=>void}){
  const [data,setData]=useState<ThemeDetail|null>(null),[draft,setDraft]=useState<Draft|null>(null),[preview,setPreview]=useState<Preview|null>(null);
  const [tab,setTab]=useState<'layout'|'clock'|'theme'|'layers'>('layout'),[selected,setSelected]=useState<RowKey|null>('time');
  const [playing,setPlaying]=useState(true),[tilt,setTilt]=useState(false),[mask,setMask]=useState(false);
  const [phase,setPhase]=useState('读取主题'),[busy,setBusy]=useState(true),[enhancing,setEnhancing]=useState(false),[error,setError]=useState('');
  const [fonts,setFonts]=useState<FontOption[]>([]),[propertySearch,setPropertySearch]=useState(''),[layerId,setLayerId]=useState('');
  const [templateName,setTemplateName]=useState(''),[naming,setNaming]=useState(false),[saving,setSaving]=useState(false);
  const alive=useRef(true),latest=useRef<Draft|null>(null),clockRequest=useRef(0),previewRequest=useRef(0);
  latest.current=draft;
  useEffect(()=>{
    alive.current=true;
    void window.yingchuang.detail(theme.id).then(value=>{if(alive.current){setData(value);setDraft(value.draft);setLayerId(value.detail.layers.find(l=>l.visible)?.id||'');}}).catch(e=>{setError(e.message);setBusy(false);});
    void window.yingchuang.fonts().then(setFonts).catch(()=>{});
    const unsubscribe=window.yingchuang.onPreviewProgress(e=>{if(e.id===theme.id&&alive.current)setPhase(e.phase);});
    const ready=window.yingchuang.onPreviewReady(e=>{if(e.id!==theme.id||e.requestId!==previewRequest.current||!alive.current)return;setEnhancing(false);if(e.error){setError(e.error);return;}if(e.data){setPreview(p=>({...e.data!,clock:p?.clock??e.data!.clock,clockRoot:p?.clockRoot||e.data!.clockRoot}));}});
    return()=>{alive.current=false;unsubscribe();ready();void window.yingchuang.cancelPreview();};
  },[theme.id]);
  const graphicsKey=draft?JSON.stringify([draft.properties,draft.layers,draft.layout.clock.enabled,draft.motion.fps]):'';
  const clockKey=draft?clockSignature(draft):'';
  useEffect(()=>{
    if(!draft||!data)return;
    if(!data.detail.renderable){setBusy(false);setError(data.detail.reason||'此类主题的背屏转换尚未接入。');return;}
    const serial=++previewRequest.current;setBusy(true);setError('');setPhase('生成预览');
    const timer=setTimeout(()=>{
      const snapshot=latest.current!;
      void window.yingchuang.preview(theme.id,snapshot,serial).then(async result=>{
        if(!alive.current||serial!==previewRequest.current)return;
        setPreview(result);setEnhancing(Boolean(result.progressive));setError(result.clockError||'');
        if(clockSignature(snapshot)!==clockSignature(latest.current!)){
          const update=await window.yingchuang.clock(theme.id,latest.current!);if(alive.current&&serial===previewRequest.current)setPreview(p=>p?{...p,...update}:p);
        }
      }).catch(e=>{if(alive.current&&serial===previewRequest.current){setBusy(false);if(!e.message.includes('已取消'))setError(e.message);}});
    },preview?600:0);
    return()=>clearTimeout(timer);
  },[graphicsKey,Boolean(data)]);
  useEffect(()=>{
    if(!draft||!preview)return;
    const serial=++clockRequest.current;
    const timer=setTimeout(()=>{
      void window.yingchuang.clock(theme.id,latest.current!).then(result=>{if(alive.current&&serial===clockRequest.current){setPreview(p=>p?{...p,...result}:p);setError('');}})
        .catch(e=>{if(alive.current&&serial===clockRequest.current)setError(e.message);});
    },450);
    return()=>clearTimeout(timer);
  },[clockKey]);
  async function finish(convert=false){
    if(!draft||saving)return;setSaving(true);
    try{await window.yingchuang.saveDraft(theme.id,draft);if(convert){await window.yingchuang.enqueue({ids:[theme.id],deviceId:draft.deviceId});onConvert();}onClose();}
    catch(e){onToast((e as Error).message);setSaving(false);}
  }
  const update=(fn:(d:Draft)=>void)=>setDraft(old=>{if(!old)return old;const d=structuredClone(old);fn(d);return d;});
  const updateLayout=(layout:Layout)=>update(d=>{d.layout=layout;});
  const device=state.devices.find(d=>d.id===draft?.deviceId)||state.devices[state.devices.length-1];
  const row=selected||'time';
  const sourceLayer=data?.detail.layers.find(l=>l.id===layerId);
  const layerValue=(key:string)=>draft?.layers[layerId]?.[key]??sourceLayer?.[key as keyof SourceLayer];
  function changeLayer(key:string,value:unknown){update(d=>{d.layers[layerId]={...d.layers[layerId],[key]:value};});}
  const displayProperties=data?.properties.filter(p=>p.type!=='text'&&conditionVisible(p.condition,draft?.properties||{})&&(!propertySearch||p.label.toLowerCase().includes(propertySearch.toLowerCase())))||[];
  useEffect(()=>{
    const listener=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();void finish();}};
    document.addEventListener('keydown',listener);return()=>document.removeEventListener('keydown',listener);
  },[draft]);
  return <div className="modal-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)void finish();}}>
    <section className="editor glass-panel" role="dialog" aria-modal="true" aria-label={`编辑 ${theme.title}`}>
      <header className="editor-header"><div className="editor-title"><span className="editor-mini-icon"><SlidersHorizontal size={18}/></span><div><h2>{theme.title}</h2><span>编辑壁纸</span></div></div><button className="icon-button" aria-label="关闭编辑器" onClick={()=>void finish()}><X size={20}/></button></header>
      <div className="editor-body"><div className="preview-panel">
        <div className="preview-heading"><span>背屏预览</span><div className="device-compact"><Select aria-label="适配机型" value={device.id} onChange={e=>update(d=>{d.deviceId=e.target.value;})}>{state.devices.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</Select><ChevronDown size={13}/><span>{device.width} × {device.height}</span></div></div>
        <div className="preview-stage"><div className="device-frame" style={{'--screen-ratio':device.width/device.height} as React.CSSProperties}>
          {draft?<PreviewCanvas preview={preview} draft={draft} device={device} poster={theme.preview} playing={playing} tilt={tilt} mask={mask} selected={selected} onSelect={key=>{setSelected(key);if(key)setTab('clock');}} onLayout={updateLayout} onError={message=>{setBusy(false);setError(message);}} onReady={()=>{setBusy(false);if(preview?.progressive)void window.yingchuang.previewMotion(theme.id,previewRequest.current);}}/>:<img src={theme.preview} alt=""/>}
          {(busy||enhancing)&&<div className="preview-status"><LoaderCircle size={14} className="spin"/>{busy?phase:"正在补齐动效，可继续编辑"}</div>}
        </div></div>
        <div className="preview-tools glass-toolbar"><div><button className={`icon-button ${!playing?'active':''}`} aria-label={playing?'暂停动效':'播放动效'} onClick={()=>setPlaying(!playing)}>{playing?<Pause size={17}/>:<Play size={17}/>}</button><span className="tool-divider"/><button className={`tool-button ${!tilt?'active':''}`} onClick={()=>setTilt(false)}><Move size={15}/>排版</button><button className={`tool-button ${tilt?'active':''}`} onClick={()=>setTilt(true)}><MousePointer2 size={15}/>感应</button></div><button className={`tool-button ${mask?'active':''}`} onClick={()=>setMask(!mask)}>避让区域</button></div>
        {error&&<div className="editor-error" role="status">{error.replace(/^Error invoking remote method '[^']+': Error: /,'')}</div>}
        {preview?.notes?.length? <details className="conversion-notes"><summary>转换说明 <span>{preview.notes.length}</span></summary><ul>{preview.notes.map((note,i)=><li key={i}>{note}</li>)}</ul></details>:null}
      </div><aside className="inspector">
        <nav className="inspector-tabs" aria-label="编辑分类">{([['layout','排版',LayoutTemplate],['clock','时间',Clock3],['theme','主题',SlidersHorizontal],['layers','图层',Layers]] as const).map(([key,label,Icon])=><button key={key} className={tab===key?'active':''} onClick={()=>setTab(key)}><Icon size={15}/>{label}</button>)}</nav>
        {!draft||!data?<div className="inspector-loading"><LoaderCircle className="spin" size={20}/></div>:<div className="inspector-scroll">
          {tab==='layout'&&<>
            <div className="inspector-section"><div className="section-title">画面<ResetButton label="重置取景" onClick={()=>update(d=>{d.layout.scale=1.06;d.layout.x=.5;d.layout.y=.5;})}/></div>
              <Slider label="缩放" value={draft.layout.scale*100} min={20} max={300} suffix="%" onChange={v=>update(d=>{d.layout.scale=v/100;})}/>
              <div className="two-fields"><label>水平<input aria-label="水平取景" type="number" min={0} max={100} value={Math.round(draft.layout.x*100)} onChange={e=>update(d=>{d.layout.x=Number(e.target.value)/100;})}/></label><label>垂直<input aria-label="垂直取景" type="number" min={0} max={100} value={Math.round(draft.layout.y*100)} onChange={e=>update(d=>{d.layout.y=Number(e.target.value)/100;})}/></label></div>
            </div>
            <details className="inspector-section advanced"><summary>感应与动效</summary><Slider label="感应幅度" value={draft.motion.amount*100} min={0} max={10} step={.1} digits={1} suffix="%" onChange={v=>update(d=>{d.motion.amount=v/100;})}/><Slider label="平滑程度" value={(1-draft.motion.smoothing)*100} min={0} max={98} suffix="%" onChange={v=>update(d=>{d.motion.smoothing=1-v/100;})}/><label className="stack-field"><span>播放帧率</span><Select aria-label="播放帧率" value={draft.motion.fps} onChange={e=>update(d=>{d.motion.fps=Number(e.target.value);})}>{[15,24,30,60,120].map(n=><option key={n} value={n}>{n} 帧 / 秒</option>)}</Select></label></details>
          </>}
          {tab==='clock'&&<>
            <div className="inspector-section"><Toggle label="日期与时间" checked={draft.layout.clock.enabled} onChange={async v=>{
              let initialFont='';
              if(v&&!data.detail.fontIssue&&!data.detail.fonts.length){const available=fonts.length?fonts:await window.yingchuang.fonts();const regular=available.filter(f=>!/Bold|Black|Italic|Heavy|粗|斜/i.test(f.label));for(const pattern of [/MiSans/i,/Microsoft YaHei|微软雅黑/i,/Noto Sans CJK|思源黑体/i,/DejaVu Sans$/i]){initialFont=regular.find(f=>pattern.test(f.label))?.value||'';if(initialFont)break;}initialFont||=regular[0]?.value||available[0]?.value||'';}
              update(d=>{d.layout.clock.enabled=v;if(initialFont)for(const key of rows)if(!d.appearance.fonts[key])d.appearance.fonts[key]=initialFont;});
            }}/>
              {draft.layout.clock.enabled&&<><div className="row-tabs">{rows.map(key=><button className={row===key?'active':''} key={key} onClick={()=>setSelected(key)}>{rowNames[key]}</button>)}</div>
                <Toggle label={`显示${rowNames[row]}`} checked={draft.layout.clock.rows[row].visible} onChange={v=>update(d=>{d.layout.clock.rows[row].visible=v;})}/>
                <div className="two-fields"><label>横向位置<input aria-label={`${rowNames[row]}横向位置`} type="number" min={0} max={100} value={Number((draft.layout.clock.rows[row].x*100).toFixed(1))} onChange={e=>update(d=>{d.layout.clock.rows[row].x=Number(e.target.value)/100;})}/></label><label>纵向位置<input aria-label={`${rowNames[row]}纵向位置`} type="number" min={0} max={100} value={Number((draft.layout.clock.rows[row].y*100).toFixed(1))} onChange={e=>update(d=>{d.layout.clock.rows[row].y=Number(e.target.value)/100;})}/></label></div>
                <label className="stack-field"><span>字体</span><Select aria-label={`${rowNames[row]}字体`} value={draft.appearance.fonts[row]} onChange={async e=>{const value=e.target.value;if(value==='__file'){const file=await window.yingchuang.chooseFile('font');if(file){setFonts(old=>[{value:file,label:file.split(/[\\/]/).pop()||file},...old]);update(d=>{d.appearance.fonts[row]=file;});}}else update(d=>{d.appearance.fonts[row]=value;});}}><option value="">原主题字体</option>{data.detail.fonts.length>0&&<optgroup label="主题内置字体">{data.detail.fonts.map((f,i)=><option key={i} value={f.value}>{f.label}</option>)}</optgroup>}<optgroup label="本机字体">{fonts.map((f,i)=><option key={i} value={f.value}>{f.label}</option>)}</optgroup><option value="__file">选择字体文件…</option></Select></label>
                <Slider label="字号" value={draft.layout.clock.rows[row].size} min={10} max={180} onChange={v=>update(d=>{d.layout.clock.rows[row].size=v;})}/>
                <div className="color-field"><span>颜色</span><div className="color-controls"><ColorWell label={`${rowNames[row]}颜色`} value={draft.appearance.colors[row]||data.detail.sourceColors?.[row]||'#ffffff'} onChange={value=>update(d=>{d.appearance.colors[row]=value;})}/><ResetButton label="使用原主题颜色" onClick={()=>update(d=>{d.appearance.colors[row]='';})}/></div></div>
                <div className="alignment-field"><span>对齐</span><div className="segmented">{([['left',AlignLeft],['center',AlignCenter],['right',AlignRight]] as const).map(([align,Icon])=><button aria-label={`${rowNames[row]}${align==='left'?'左对齐':align==='right'?'右对齐':'居中'}`} key={align} className={draft.layout.clock.rows[row].align===align?'active':''} onClick={()=>update(d=>{d.layout.clock.rows[row].align=align;})}><Icon size={16}/></button>)}</div></div>
                {row==='week'&&<label className="stack-field"><span>星期语言</span><Select aria-label="星期语言" value={draft.layout.clock.language} onChange={e=>update(d=>{d.layout.clock.language=e.target.value as 'en'|'zh';})}><option value="en">英文</option><option value="zh">中文</option></Select></label>}
                {row==='time'&&<><label className="stack-field"><span>时间格式</span><Select aria-label="时间格式" value={draft.layout.clock.format} onChange={e=>update(d=>{d.layout.clock.format=e.target.value as 'auto'|'24'|'12';})}><option value="auto">跟随主题</option><option value="24">24 小时</option><option value="12">12 小时</option></Select></label><Toggle label="显示秒数" checked={draft.layout.clock.seconds} onChange={v=>update(d=>{d.layout.clock.seconds=v;})}/></>}
              </>}
            </div>
          </>}
          {tab==='theme'&&<><label className="inspector-search"><Search size={14}/><input placeholder="查找主题设置" value={propertySearch} onChange={e=>setPropertySearch(e.target.value)}/></label>{theme.type==='video'&&<><Slider label="播放速度" value={Number(draft.properties.__videoSpeed??1)} min={.25} max={2} step={.05} digits={2} suffix="×" onChange={v=>update(d=>{d.properties.__videoSpeed=v;})}/><Slider label="导出音量" value={Number(draft.properties.__videoVolume??0)*100} min={0} max={100} suffix="%" onChange={v=>update(d=>{d.properties.__videoVolume=v/100;})}/></>}<div className="property-fields">{displayProperties.map(p=><PropertyControl key={p.key} property={p} value={draft.properties[p.key]??p.value} onChange={value=>update(d=>{d.properties[p.key]=value;})}/>)}{!displayProperties.length&&<div className="empty-small">没有匹配的设置</div>}</div><button className="text-button" onClick={()=>update(d=>{d.properties=Object.fromEntries(data.properties.filter(p=>'value'in p).map(p=>[p.key,p.value]));})}><RotateCcw size={13}/>恢复主题设置</button></>}
          {tab==='layers'&&<><label className="stack-field"><span>选择图层</span><Select aria-label="选择图层" value={layerId} onChange={e=>setLayerId(e.target.value)}>{data.detail.layers.map(l=><option key={l.id} value={l.id}>{l.name}</option>)}</Select></label>{sourceLayer&&<><Toggle label="显示图层" checked={Boolean(layerValue('visible'))} onChange={v=>changeLayer('visible',v)}/><Slider label="图层横向位置" value={Number(layerValue('x'))*100} min={-100} max={200} suffix="%" onChange={v=>changeLayer('x',v/100)}/><Slider label="图层纵向位置" value={Number(layerValue('y'))*100} min={-100} max={200} suffix="%" onChange={v=>changeLayer('y',v/100)}/><Slider label="图层缩放" value={Number(draft.layers[layerId]?.scale??1)*100} min={1} max={300} suffix="%" onChange={v=>changeLayer('scale',v/100)}/><Slider label="图层旋转" value={Number(draft.layers[layerId]?.rotation??0)} min={-180} max={180} suffix="°" onChange={v=>changeLayer('rotation',v)}/><Slider label="不透明度" value={Number(layerValue('alpha'))*100} min={0} max={100} suffix="%" onChange={v=>changeLayer('alpha',v/100)}/><label className="color-field"><span>图层颜色</span><input aria-label="图层颜色" type="color" value={colorHex(layerValue('color'))} onChange={e=>changeLayer('color',sourceColor(e.target.value))}/></label>{sourceLayer.kind==='text'&&<><label className="stack-field"><span>文字内容</span><textarea aria-label="文字内容" value={String(layerValue('text')??'')} onChange={e=>changeLayer('text',e.target.value)}/></label><label className="stack-field"><span>图层字体</span><Select aria-label="图层字体" value={String(draft.layers[layerId]?.font||'')} onChange={async e=>{const value=e.target.value;if(value==='__file'){const file=await window.yingchuang.chooseFile('font');if(file){setFonts(old=>[{value:file,label:file.split(/[\\/]/).pop()||file},...old]);changeLayer('font',file);}}else changeLayer('font',value);}}><option value="">原图层字体</option><optgroup label="主题内置字体">{data.detail.fonts.map((f,i)=><option key={i} value={f.value}>{f.label}</option>)}</optgroup><optgroup label="本机字体">{fonts.map((f,i)=><option key={i} value={f.value}>{f.label}</option>)}</optgroup><option value="__file">选择字体文件…</option></Select></label><Slider label="原图层字号" value={Number(layerValue('fontsize'))} min={8} max={160} onChange={v=>changeLayer('fontsize',v)}/></>}<button className="text-button" onClick={()=>update(d=>{delete d.layers[layerId];})}><RotateCcw size={13}/>恢复此图层</button></>}</>}
        </div>}
      </aside></div>
      <footer className="editor-footer"><div className="footer-left">{naming?<form className="template-name" onSubmit={async e=>{e.preventDefault();if(!draft)return;onState(await window.yingchuang.saveTemplate(templateName||'我的排版',draft.layout));setNaming(false);onToast('排版模板已保存');}}><input autoFocus aria-label="模板名称" placeholder="模板名称" value={templateName} onChange={e=>setTemplateName(e.target.value)}/><button type="submit" className="icon-button" aria-label="保存模板"><Check size={17}/></button><button type="button" className="icon-button" aria-label="取消保存模板" onClick={()=>setNaming(false)}><X size={15}/></button></form>:<button className="text-button" disabled={!draft} onClick={()=>setNaming(true)}><Save size={16}/>保存排版模板</button>}<button className="icon-button subtle" title="打开原主题目录" aria-label="打开原主题目录" onClick={()=>void window.yingchuang.openTheme(theme.id)}><FolderOpen size={16}/></button></div><div className="footer-actions"><button className="button secondary" disabled={!draft||saving} onClick={()=>void finish()}>完成</button><button className="button primary" disabled={!draft||saving||!data?.detail.renderable} onClick={()=>void finish(true)}>{saving?<LoaderCircle className="spin" size={16}/>:<Type size={16}/>}转换壁纸</button></div></footer>
    </section>
  </div>;
}
