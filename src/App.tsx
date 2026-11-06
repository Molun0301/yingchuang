import { Select } from './Select';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Images, Heart, LayoutTemplate, ArrowDownToLine, Settings2, Search, Plus, RefreshCw, Check, ChevronDown, X, Minus, Square, FolderOpen, CheckCheck, LoaderCircle, SlidersHorizontal, CircleCheck, CircleX, Trash2, Clock3, MonitorSmartphone, ArrowUpRight, CheckSquare2 } from 'lucide-react';
import type { AppState, Device, Template, Theme } from './types';
import { Editor } from './Editor';

type Page='library'|'favorites'|'templates'|'queue'|'settings';
const typeNames:Record<string,string>={scene:'场景',video:'视频',web:'网页',image:'图片',application:'应用'};

function Logo(){return <span className="brand-mark" aria-hidden="true"><span/><span/><i/></span>;}
function DeviceSelect({devices,value,onChange}:{devices:Device[];value:string;onChange:(v:string)=>void}){
  return <label className="device-select"><MonitorSmartphone size={16}/><Select aria-label="导出机型" value={value} onChange={e=>onChange(e.target.value)}>{[...new Set(devices.map(d=>d.series))].map(series=><optgroup key={series} label={series}>{devices.filter(d=>d.series===series).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</optgroup>)}</Select><ChevronDown size={13}/></label>;
}
function TemplateThumbnail({template}:{template:Template}){
  return <div className="template-thumbnail"><div className="template-phone"><div className="template-camera"><i/><i/></div>{(['week','date','time'] as const).map(key=>{const row=template.layout.rows[key];return template.layout.clockEnabled!==false&&row.visible&&<span key={key} style={{left:`${row.x*100}%`,top:`${row.y*100}%`,fontSize:`${row.size/6.2}px`,transform:`translate(${row.align==='center'?'-50%':row.align==='right'?'-100%':'0'},-50%)`}}>{key==='week'?'FRIDAY':key==='date'?'2026.11.06':'10:08'}</span>;})}</div></div>;
}

export function App(){
  const [state,setState]=useState<AppState|null>(null),[page,setPage]=useState<Page>('library'),[search,setSearch]=useState('');
  const [filter,setFilter]=useState('all'),[sort,setSort]=useState('recent'),[selected,setSelected]=useState(new Set<string>()),[selecting,setSelecting]=useState(false);
  const [editing,setEditing]=useState<Theme|null>(null),[refreshing,setRefreshing]=useState(false),[starting,setStarting]=useState(false),[templateId,setTemplateId]=useState('');
  const [toast,setToast]=useState(''),[initialError,setInitialError]=useState('');
  const lastSelected=useRef(''),toastTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const notify=(message:string)=>{setToast(message.replace(/^Error invoking remote method '[^']+': Error: /,''));clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast(''),3400);};
  const merge=(value:Partial<AppState>)=>setState(old=>old?{...old,...value}:old);
  useEffect(()=>{
    void window.yingchuang.bootstrap().then(setState).catch(e=>setInitialError(e.message));
    return window.yingchuang.onQueue(items=>setState(old=>old?{...old,queue:items}:old));
  },[]);
  const themes=useMemo(()=>{
    if(!state)return [];
    let items=state.themes.filter(t=>(page!=='favorites'||state.favorites.includes(t.id))&&(filter==='all'||t.type===filter)&&t.title.toLowerCase().includes(search.toLowerCase()));
    if(sort==='name')items=[...items].sort((a,b)=>a.title.localeCompare(b.title,'zh-CN'));
    return items;
  },[state?.themes,state?.favorites,page,search,filter,sort]);
  const active=state?.queue.filter(i=>i.status==='running'||i.status==='waiting').length||0;
  const allSelected=themes.length>0&&themes.every(t=>selected.has(t.id));
  const libraryPage=page==='library'||page==='favorites';
  async function refresh(){setRefreshing(true);try{setState(await window.yingchuang.refresh());}catch(e){notify((e as Error).message);}finally{setRefreshing(false);}}
  async function addDirectory(){const next=await window.yingchuang.chooseDirectory('library');if(next)setState(next);}
  async function convert(){if(!state||!selected.size||starting)return;setStarting(true);try{const items=await window.yingchuang.enqueue({ids:[...selected],templateId:templateId||undefined,deviceId:state.settings.deviceId});merge({queue:items});setSelected(new Set());setSelecting(false);setPage('queue');}catch(e){notify((e as Error).message);}finally{setStarting(false);}}
  function select(id:string,shift=false){setSelected(old=>{const next=new Set(old);if(shift&&lastSelected.current){const a=themes.findIndex(t=>t.id===id),b=themes.findIndex(t=>t.id===lastSelected.current);for(const t of themes.slice(Math.min(a,b),Math.max(a,b)+1))next.add(t.id);}else if(next.has(id))next.delete(id);else next.add(id);return next;});lastSelected.current=id;}
  function selectAll(){setSelected(old=>{const next=new Set(old);for(const theme of themes){if(allSelected)next.delete(theme.id);else next.add(theme.id);}return next;});}
  useEffect(()=>{
    function key(event:KeyboardEvent){
      if(editing||!libraryPage||['INPUT','TEXTAREA','SELECT'].includes((event.target as HTMLElement)?.tagName))return;
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='a'){event.preventDefault();setSelected(new Set(themes.map(t=>t.id)));setSelecting(true);}
      if(event.key==='Escape'){setSelected(new Set());setSelecting(false);}
      if((event.ctrlKey||event.metaKey)&&event.key==='Enter'){event.preventDefault();void convert();}
    }
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[editing,libraryPage,themes,selected,templateId,state?.settings.deviceId]);
  if(!state)return <main className="launch-screen"><Logo/><h1>映窗</h1>{initialError?<p>{initialError}</p>:<LoaderCircle className="spin" size={20}/>}</main>;
  const titles:Record<Page,string>={library:'我的壁纸',favorites:'我的收藏',templates:'排版模板',queue:'转换队列',settings:'设置'};
  return <div className="app-shell">
    <div className="window-drag-region"/><div className="window-controls"><button aria-label="最小化" onClick={()=>void window.yingchuang.windowControl('minimize')}><Minus size={15}/></button><button aria-label="最大化" onClick={()=>void window.yingchuang.windowControl('maximize')}><Square size={11}/></button><button aria-label="关闭应用" className="window-close" onClick={()=>void window.yingchuang.windowControl('close')}><X size={16}/></button></div>
    <aside className="sidebar"><a className="brand" href="#" onClick={e=>{e.preventDefault();setPage('library');}}><Logo/><span>映窗</span></a>
      <nav className="main-nav">{([['library','壁纸库',Images],['favorites','我的收藏',Heart],['templates','排版模板',LayoutTemplate],['queue','转换队列',ArrowDownToLine]] as const).map(([id,label,Icon])=><button key={id} className={page===id?'active':''} onClick={()=>{setPage(id);setSearch('');}}><Icon size={19} strokeWidth={1.65}/><span>{label}</span>{id==='library'?<small>{state.themes.length}</small>:id==='queue'&&active>0?<small className="active-count">{active}</small>:null}</button>)}</nav>
      <div className="sidebar-bottom"><button className={`settings-nav ${page==='settings'?'active':''}`} onClick={()=>setPage('settings')}><Settings2 size={18}/><span>设置</span></button><span className="app-version">映窗 {state.version}</span></div>
    </aside>
    <main className={`workspace ${selected.size&&libraryPage?'has-selection':''}`}>
      <header className="page-header"><div><h1>{titles[page]}</h1><p>{libraryPage?`${themes.length} 个主题`:page==='templates'?`${state.templates.length} 个模板`:page==='queue'?active?`${active} 项正在处理`:`${state.queue.filter(i=>i.status==='done').length} 项已完成`:'壁纸目录与导出偏好'}</p></div>
        <div className="page-actions">{libraryPage&&<><label className="search-field"><Search size={17}/><input placeholder="搜索壁纸" aria-label="搜索壁纸" value={search} onChange={e=>setSearch(e.target.value)}/>{search&&<button className="icon-button" aria-label="清除搜索" onClick={()=>setSearch('')}><X size={13}/></button>}</label><button className="button secondary" onClick={()=>void addDirectory()}><Plus size={16}/>添加目录</button></>}
          {page==='queue'&&<button className="button secondary" onClick={()=>void window.yingchuang.openOutput()}><FolderOpen size={16}/>导出目录</button>}
        </div>
      </header>
      {libraryPage&&<>
        <div className="library-toolbar"><div className="filter-tabs">{[['all','全部'],['scene','场景'],['video','视频'],['web','网页']].map(([key,label])=><button key={key} className={filter===key?'active':''} onClick={()=>setFilter(key)}>{label}</button>)}</div><div className="toolbar-right"><button className={`text-button ${selecting?'is-selected':''}`} onClick={()=>{setSelecting(!selecting);if(selecting)setSelected(new Set());}}><CheckSquare2 size={15}/>{selecting?'完成选择':'多选'}</button><button className="text-button" onClick={selectAll}>{allSelected?'取消全选':'全选'}</button><span className="toolbar-divider"/><label className="sort-select"><Select aria-label="壁纸排序" value={sort} onChange={e=>setSort(e.target.value)}><option value="recent">最近添加</option><option value="name">名称排序</option></Select><ChevronDown size={12}/></label><button className="icon-button" title="刷新壁纸库" aria-label="刷新壁纸库" disabled={refreshing} onClick={()=>void refresh()}><RefreshCw size={16} className={refreshing?'spin':''}/></button></div></div>
        <div className="library-scroll">{themes.length?<div className="wallpaper-grid">{themes.map(theme=><article className={`wallpaper-card ${selected.has(theme.id)?'selected':''} ${selecting?'selection-mode':''}`} key={theme.id} data-testid={`theme-${theme.workshopId||theme.id}`}>
          <button className="card-picture" aria-label={`编辑 ${theme.title}`} onClick={e=>{if(selecting||e.ctrlKey||e.metaKey||e.shiftKey){select(theme.id,e.shiftKey);setSelecting(true);}else setEditing(theme);}}><img src={theme.preview} alt={theme.title} loading="lazy" draggable="false"/><span className="card-shade"/><span className="card-edit"><SlidersHorizontal size={16}/></span>{theme.type==='video'&&<span className="video-badge"><span/></span>}</button>
          <button className="card-select" aria-label={`${selected.has(theme.id)?'取消选择':'选择'} ${theme.title}`} aria-pressed={selected.has(theme.id)} onClick={e=>select(theme.id,e.shiftKey)}>{selected.has(theme.id)&&<Check size={14} strokeWidth={2.6}/>}</button>
          <button className={`card-favorite ${state.favorites.includes(theme.id)?'saved':''}`} aria-label={`${state.favorites.includes(theme.id)?'取消收藏':'收藏'} ${theme.title}`} onClick={async()=>merge(await window.yingchuang.favorite(theme.id))}><Heart size={16} fill={state.favorites.includes(theme.id)?'currentColor':'none'}/></button>
          <div className="card-caption"><h3 title={theme.title}>{theme.title}</h3><span>{typeNames[theme.type]||theme.type}</span></div>
        </article>)}</div>:<div className="empty-state"><div className="empty-art"><Images size={38} strokeWidth={1.2}/></div><h2>{search?'没有找到这张壁纸':page==='favorites'?'把喜欢的壁纸放在这里':'添加你的壁纸库'}</h2><p>{search?'换个名称试试':page==='favorites'?'点击封面上的爱心即可收藏':'选择 Steam 或 Wallpaper Engine 目录'}</p>{page!=='favorites'&&!search&&<button className="button primary" onClick={()=>void addDirectory()}><Plus size={16}/>添加目录</button>}</div>}</div>
        {selected.size>0&&<div className="selection-dock glass-panel"><div className="selection-count"><span><CheckCheck size={17}/></span><b>已选 {selected.size} 项</b><button className="icon-button" aria-label="清空选择" onClick={()=>{setSelected(new Set());setSelecting(false);}}><X size={14}/></button></div><div className="dock-actions"><label className="template-select"><LayoutTemplate size={16}/><Select aria-label="批量排版模板" value={templateId} onChange={e=>setTemplateId(e.target.value)}><option value="">各自排版</option>{state.templates.map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</Select><ChevronDown size={12}/></label><DeviceSelect devices={state.devices} value={state.settings.deviceId} onChange={async value=>merge(await window.yingchuang.settings({deviceId:value}))}/><button className="button primary" disabled={starting} onClick={()=>void convert()}>{starting?<LoaderCircle size={16} className="spin"/>:<ArrowDownToLine size={16}/>}批量转换</button></div></div>}
      </>}
      {page==='templates'&&<div className="content-scroll"><div className="template-grid">{state.templates.map(template=><article className="template-card" key={template.id}><TemplateThumbnail template={template}/><div className="template-caption"><div><h3>{template.name}</h3><span>{template.builtin?'内置排版':'我的排版'}</span></div>{!template.builtin&&<button className="icon-button" aria-label={`删除模板 ${template.name}`} onClick={async()=>{merge(await window.yingchuang.deleteTemplate(template.id));notify('模板已删除');}}><Trash2 size={16}/></button>}</div><button className="template-use" onClick={()=>{setTemplateId(template.id);setSelecting(true);setPage('library');notify('选择壁纸后即可批量套用');}}>选择壁纸使用<ArrowUpRight size={15}/></button></article>)}</div><p className="quiet-note">在编辑器中保存新排版，主题内容和原字体会各自保留。</p></div>}
      {page==='queue'&&<div className="content-scroll"><div className="queue-toolbar"><span>{state.queue.length} 个任务</span><div>{active>0&&<button className="text-button" onClick={()=>void window.yingchuang.cancelQueue()}>取消剩余</button>}<button className="text-button" onClick={()=>void window.yingchuang.clearQueue()}>清空记录</button></div></div>{state.queue.length?<div className="queue-list">{state.queue.map(item=>{const theme=state.themes.find(t=>t.id===item.themeId);const d=state.devices.find(d=>d.id===item.deviceId);return <article className={`queue-item ${item.status}`} key={item.id}><div className="queue-cover"><img src={theme?.preview} alt=""/></div><div className="queue-info"><h3>{item.title}</h3><p>{d?.name}<span>{d?.width} × {d?.height}</span></p>{item.status==='running'&&<div className="queue-progress"><span style={{width:`${item.progress}%`}}/></div>}{item.status==='error'&&<p className="queue-error">{item.error}</p>}</div><div className="queue-status">{item.status==='running'?<><LoaderCircle size={15} className="spin"/>{item.phase}</>:item.status==='done'?<><CircleCheck size={16}/>已完成</>:item.status==='error'?<><CircleX size={16}/>未完成</>:item.status==='waiting'?<><Clock3 size={15}/>等待</>:<>已取消</>}</div><div className="queue-action">{item.status==='done'?<button className="icon-button" aria-label={`打开 ${item.title} 导出目录`} onClick={()=>void window.yingchuang.openOutput(item.id)}><FolderOpen size={18}/></button>:['waiting','running'].includes(item.status)?<button className="icon-button" aria-label={`取消 ${item.title}`} onClick={()=>void window.yingchuang.cancelQueue(item.id)}><X size={17}/></button>:null}</div></article>;})}</div>:<div className="empty-state"><div className="empty-art"><ArrowDownToLine size={38} strokeWidth={1.2}/></div><h2>还没有转换任务</h2><p>从壁纸库挑选喜欢的画面</p><button className="button secondary" onClick={()=>setPage('library')}>浏览壁纸</button></div>}</div>}
      {page==='settings'&&<div className="content-scroll settings-page"><section className="settings-section"><h2>导出</h2><div className="settings-row"><div><h3>默认机型</h3><p>预览与导出使用相同尺寸</p></div><DeviceSelect devices={state.devices} value={state.settings.deviceId} onChange={async value=>merge(await window.yingchuang.settings({deviceId:value}))}/></div><div className="settings-row"><div><h3>保存位置</h3><p className="path-text" title={state.settings.outputDirectory}>{state.settings.outputDirectory}</p></div><button className="button secondary" onClick={async()=>{const next=await window.yingchuang.chooseDirectory('output');if(next)setState(next);}}><FolderOpen size={15}/>选择目录</button></div></section>
        <section className="settings-section"><div className="settings-section-heading"><h2>壁纸目录</h2><button className="text-button" onClick={()=>void addDirectory()}><Plus size={15}/>添加</button></div>{state.roots.map(root=><div className="directory-row" key={root}><FolderOpen size={18}/><div><span title={root}>{root}</span><small>自动发现</small></div></div>)}{state.settings.roots.map(root=><div className="directory-row" key={'manual-'+root}><FolderOpen size={18}/><div><span title={root}>{root}</span><small>手动添加</small></div><button className="icon-button" aria-label={`移除目录 ${root}`} onClick={async()=>setState(await window.yingchuang.removeDirectory(root))}><X size={16}/></button></div>)}</section>
        <section className="settings-section"><h2>内置机型</h2><div className="device-grid">{state.devices.map(device=><div key={device.id}><MonitorSmartphone size={22} strokeWidth={1.3}/><span>{device.name}<small>{device.width} × {device.height}</small></span></div>)}</div></section>
      </div>}
    </main>
    {editing&&<Editor theme={editing} state={state} onClose={()=>setEditing(null)} onState={merge} onConvert={()=>setPage('queue')} onToast={notify}/>}
    {toast&&<div className="toast" role="status"><Check size={15}/>{toast}</div>}
  </div>;
}
