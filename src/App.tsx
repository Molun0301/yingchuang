import { Select } from './Select';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Images, Heart, LayoutTemplate, ArrowDownToLine, Settings2, Search, Plus, RefreshCw, Check, X, Minus, Square, FolderOpen, CheckCheck, LoaderCircle, SlidersHorizontal, CircleCheck, CircleX, Trash2, Clock3, MonitorSmartphone, ArrowUpRight, CheckSquare2, Droplets, CloudFog, Sun, Moon, SunMoon, LayoutGrid, Grid3x3, Info, Sparkles } from 'lucide-react';
import type { AppState, Device, Template, Theme } from './types';
import { Editor } from './Editor';
import { AppearanceContext, Glass, defaultAppearance, useApplyAppearance, type Appearance } from './appearance';
import { Ambient, FadeImage, Logo, Segmented, TypeIcon, typeNames, useNavIndicator, type ToastKind } from './ui';
import { Toggle } from './controls';
import widgetDefinitions from '../core/组件.json';
import { useUpdater, UpdateBadge, UpdateDialog, UpdateSettingsSection } from './Updater';

type Page = 'library' | 'favorites' | 'templates' | 'queue' | 'settings';

function DeviceSelect({ devices, value, onChange }: { devices: Device[]; value: string; onChange: (v: string) => void }) {
  return <label className="device-select"><MonitorSmartphone size={16}/><Select aria-label="导出机型" value={value} onChange={e => onChange(e.target.value)}>{[...new Set(devices.map(d => d.series))].map(series => <optgroup key={series} label={series}>{devices.filter(d => d.series === series).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</optgroup>)}</Select></label>;
}
function TemplateThumbnail({ template }: { template: Template }) {
  return <div className="template-thumbnail"><div className="template-phone"><div className="template-camera"><i/><i/></div>{widgetDefinitions.widgets.map(widget => { const row = template.layout.rows[widget.key]; return template.layout.clockEnabled !== false && row?.visible && <span key={widget.key} style={{ left: `${row.x * 100}%`, top: `${row.y * 100}%`, fontSize: `${row.size / 6.2}px`, transform: `translate(${row.align === 'center' ? '-50%' : row.align === 'right' ? '-100%' : '0'},-50%)` }}>{widget.key === 'week' && template.layout.language === 'zh' ? '星期五' : widget.key === 'text' ? row.text ?? widget.sample : widget.sample}</span>; })}</div></div>;
}
function EmptyArt({ icon }: { icon: React.ReactNode }) { return <div className="empty-art"><span/><span>{icon}</span></div>; }

export function App() {
  const [state, setState] = useState<AppState | null>(null), [page, setPage] = useState<Page>('library'), [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all'), [sort, setSort] = useState('recent'), [selected, setSelected] = useState(new Set<string>()), [selecting, setSelecting] = useState(false);
  const [editing, setEditing] = useState<Theme | null>(null), [refreshing, setRefreshing] = useState(false), [starting, setStarting] = useState(false), [templateId, setTemplateId] = useState('');
  const [toast, setToast] = useState<{ message: string; kind: ToastKind; key: number } | null>(null), [initialError, setInitialError] = useState('');
  const [hovered, setHovered] = useState('');
  const lastSelected = useRef(''), toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchInput = useRef<HTMLInputElement>(null);
  const appearance: Appearance = { ...defaultAppearance, ...state?.settings.appearance };
  useApplyAppearance(appearance);
  const notify = (message: string, kind: ToastKind = 'success') => {
    setToast({ message: message.replace(/^Error invoking remote method '[^']+': Error: /, ''), kind, key: Date.now() });
    clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), 3400);
  };
  const updater = useUpdater(notify);
  const merge = (value: Partial<AppState>) => setState(old => old ? { ...old, ...value } : old);
  const setAppearance = async (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch };
    setState(old => old ? { ...old, settings: { ...old.settings, appearance: next } } : old);
    merge(await window.yingchuang.settings({ appearance: next }));
  };
  useEffect(() => {
    void window.yingchuang.bootstrap().then(setState).catch(e => setInitialError(e.message));
    return window.yingchuang.onQueue(items => setState(old => old ? { ...old, queue: items } : old));
  }, []);
  const themes = useMemo(() => {
    if (!state) return [];
    let items = state.themes.filter(t => (page !== 'favorites' || state.favorites.includes(t.id)) && (filter === 'all' || t.type === filter) && t.title.toLowerCase().includes(search.toLowerCase()));
    if (sort === 'name') items = [...items].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    return items;
  }, [state?.themes, state?.favorites, page, search, filter, sort]);
  const counts = useMemo(() => {
    const result: Record<string, number> = { all: 0 };
    for (const t of state?.themes || []) if (page !== 'favorites' || state?.favorites.includes(t.id)) { result.all++; result[t.type] = (result[t.type] || 0) + 1; }
    return result;
  }, [state?.themes, state?.favorites, page]);
  const active = state?.queue.filter(i => i.status === 'running' || i.status === 'waiting').length || 0;
  const allSelected = themes.length > 0 && themes.every(t => selected.has(t.id));
  const libraryPage = page === 'library' || page === 'favorites';
  const nav = useNavIndicator(page);
  const ambientImage = editing?.preview || state?.themes.find(t => t.id === hovered)?.preview || themes[0]?.preview || state?.themes[0]?.preview || '';
  async function refresh() { setRefreshing(true); try { setState(await window.yingchuang.refresh()); notify('壁纸库已刷新', 'info'); } catch (e) { notify((e as Error).message, 'error'); } finally { setRefreshing(false); } }
  async function addDirectory() { const next = await window.yingchuang.chooseDirectory('library'); if (next) { setState(next); notify('已添加壁纸目录'); } }
  async function convert() { if (!state || !selected.size || starting) return; setStarting(true); try { const items = await window.yingchuang.enqueue({ ids: [...selected], templateId: templateId || undefined, deviceId: state.settings.deviceId }); merge({ queue: items }); setSelected(new Set()); setSelecting(false); setPage('queue'); notify(`已加入 ${items.filter(i => i.status === 'waiting' || i.status === 'running').length} 项转换`, 'info'); } catch (e) { notify((e as Error).message, 'error'); } finally { setStarting(false); } }
  function select(id: string, shift = false) { setSelected(old => { const next = new Set(old); if (shift && lastSelected.current) { const a = themes.findIndex(t => t.id === id), b = themes.findIndex(t => t.id === lastSelected.current); for (const t of themes.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(t.id); } else if (next.has(id)) next.delete(id); else next.add(id); return next; }); lastSelected.current = id; }
  function selectAll() { setSelected(old => { const next = new Set(old); for (const theme of themes) { if (allSelected) next.delete(theme.id); else next.add(theme.id); } return next; }); }
  function hover(id: string) { clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => { setHovered(id); if (!editing) void window.yingchuang.prefetch(id); }, 260); }
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (editing) return;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f' && libraryPage) { event.preventDefault(); searchInput.current?.focus(); searchInput.current?.select(); return; }
      if (!libraryPage || typing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelected(new Set(themes.map(t => t.id))); setSelecting(true); }
      if (event.key === 'Escape') { setSelected(new Set()); setSelecting(false); }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void convert(); }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [editing, libraryPage, themes, selected, templateId, state?.settings.deviceId]);
  if (!state) return <main className="launch-screen"><Ambient image="" enabled={false}/><Logo/><h1>映窗</h1>{initialError ? <p>{initialError}</p> : <LoaderCircle className="spin" size={20}/>}</main>;
  const titles: Record<Page, string> = { library: '我的壁纸', favorites: '我的收藏', templates: '排版模板', queue: '转换队列', settings: '设置' };
  const schemeIcon = appearance.scheme === 'light' ? <Sun size={15}/> : appearance.scheme === 'dark' ? <Moon size={15}/> : <SunMoon size={15}/>;
  const schemeNext = { system: 'light', light: 'dark', dark: 'system' } as const;
  const schemeName = { system: '跟随系统', light: '浅色', dark: '深色' };
  const filterOptions = [['all', '全部'], ['scene', '场景'], ['video', '视频'], ['web', '网页'], ['application', '应用']].filter(([key]) => key === 'all' || counts[key])
    .map(([value, label]) => ({ value, label, count: counts[value] || 0, icon: value === 'all' ? undefined : <TypeIcon type={value} size={13}/> }));
  return <AppearanceContext.Provider value={appearance}><div className="app-shell">
    <Ambient image={ambientImage} enabled={appearance.ambient}/>
    <div className="window-drag-region"/>
    <Glass className="window-controls" refraction={false}><button aria-label="最小化" onClick={() => void window.yingchuang.windowControl('minimize')}><Minus size={15}/></button><button aria-label="最大化" onClick={() => void window.yingchuang.windowControl('maximize')}><Square size={11}/></button><button aria-label="关闭应用" className="window-close" onClick={() => void window.yingchuang.windowControl('close')}><X size={16}/></button></Glass>
    <Glass as="aside" className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setPage('library'); }}><Logo/><span><b>映窗</b><small>背屏工作室</small></span></a>
      <nav className="main-nav" ref={nav.ref as React.RefObject<HTMLElement>}>{nav.indicator}{([['library', '壁纸库', Images], ['favorites', '我的收藏', Heart], ['templates', '排版模板', LayoutTemplate], ['queue', '转换队列', ArrowDownToLine]] as const).map(([id, label, Icon]) => <button key={id} data-nav={id} className={page === id ? 'active' : ''} title={label} onClick={() => { setPage(id); setSearch(''); }}><Icon size={19} strokeWidth={1.7}/><span>{label}</span>{id === 'library' ? <small>{state.themes.length}</small> : id === 'favorites' && state.favorites.length ? <small>{state.favorites.length}</small> : id === 'queue' && active > 0 ? <small className="active-count">{active}</small> : null}</button>)}</nav>
      <div className="sidebar-bottom">
        <div className="appearance-quick" role="group" aria-label="界面外观">
          <button aria-pressed={appearance.material === 'frosted'} title="磨砂玻璃" aria-label="磨砂玻璃" onClick={() => void setAppearance({ material: 'frosted' })}><CloudFog size={15}/></button>
          <button aria-pressed={appearance.material === 'liquid'} title="液态玻璃" aria-label="液态玻璃" onClick={() => void setAppearance({ material: 'liquid' })}><Droplets size={15}/></button>
          <span className="quick-divider"/>
          <button title={`配色：${schemeName[appearance.scheme]}`} aria-label={`配色：${schemeName[appearance.scheme]}，点击切换`} onClick={() => void setAppearance({ scheme: schemeNext[appearance.scheme] })}>{schemeIcon}</button>
        </div>
        <button data-nav="settings" className={`settings-nav ${page === 'settings' ? 'active' : ''}`} title="设置" onClick={() => setPage('settings')}><Settings2 size={18}/><span>设置</span></button>
        <div className="update-version-line"><span className="app-version">映窗 {state.version}</span><UpdateBadge updater={updater}/></div>
      </div>
    </Glass>
    <main className={`workspace ${selected.size && libraryPage ? 'has-selection' : ''}`}>
      <header className="page-header"><div><h1>{titles[page]}</h1><p>{libraryPage ? `${themes.length} 个主题${search ? ` · 搜索“${search}”` : ''}` : page === 'templates' ? `${state.templates.length} 个模板` : page === 'queue' ? active ? `${active} 项正在处理` : `${state.queue.filter(i => i.status === 'done').length} 项已完成` : '外观、壁纸目录与导出偏好'}</p></div>
        <div className="page-actions">{libraryPage && <><Glass className="search-field"><Search size={16}/><input ref={searchInput} placeholder="搜索壁纸" aria-label="搜索壁纸" value={search} onChange={e => setSearch(e.target.value)}/>{search ? <button className="icon-button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={13}/></button> : <kbd>Ctrl F</kbd>}</Glass><button className="button secondary" onClick={() => void addDirectory()}><Plus size={16}/>添加目录</button></>}
          {page === 'queue' && <button className="button secondary" onClick={() => void window.yingchuang.openOutput()}><FolderOpen size={16}/>导出目录</button>}
        </div>
      </header>
      {libraryPage && <>
        <div className="library-toolbar"><Segmented label="壁纸类型" value={filter} onChange={setFilter} options={filterOptions}/>
          <div className="toolbar-right"><button className={`text-button ${selecting ? 'is-selected' : ''}`} onClick={() => { setSelecting(!selecting); if (selecting) setSelected(new Set()); }}><CheckSquare2 size={15}/>{selecting ? '完成选择' : '多选'}</button><button className="text-button" onClick={selectAll}>{allSelected ? '取消全选' : '全选'}</button><span className="toolbar-divider"/>
            <button className="icon-button" title={appearance.density === 'compact' ? '大卡片' : '紧凑卡片'} aria-label={appearance.density === 'compact' ? '切换为大卡片' : '切换为紧凑卡片'} onClick={() => void setAppearance({ density: appearance.density === 'compact' ? 'comfortable' : 'compact' })}>{appearance.density === 'compact' ? <LayoutGrid size={16}/> : <Grid3x3 size={16}/>}</button>
            <label className="sort-select"><Select aria-label="壁纸排序" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">最近添加</option><option value="name">名称排序</option></Select></label>
            <button className="icon-button" title="刷新壁纸库" aria-label="刷新壁纸库" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={16} className={refreshing ? 'spin' : ''}/></button></div></div>
        <div className="library-scroll">{themes.length ? <div className="wallpaper-grid">{themes.map((theme, index) => <article className={`wallpaper-card ${selected.has(theme.id) ? 'selected' : ''} ${selecting ? 'selection-mode' : ''}`} key={theme.id} style={{ '--i': index } as React.CSSProperties} data-testid={`theme-${theme.workshopId || theme.id}`} onMouseEnter={() => hover(theme.id)}>
          <button className="card-picture" aria-label={`编辑 ${theme.title}`} onClick={e => { if (selecting || e.ctrlKey || e.metaKey || e.shiftKey) { select(theme.id, e.shiftKey); setSelecting(true); } else setEditing(theme); }}><FadeImage src={theme.preview} alt={theme.title}/><span className="card-shade"/><span className="card-sheen"/><span className="card-type"><TypeIcon type={theme.type}/>{typeNames[theme.type] || theme.type}</span><span className="card-edit"><SlidersHorizontal size={13}/>编辑</span></button>
          <button className="card-select" aria-label={`${selected.has(theme.id) ? '取消选择' : '选择'} ${theme.title}`} aria-pressed={selected.has(theme.id)} onClick={e => select(theme.id, e.shiftKey)}>{selected.has(theme.id) && <Check size={14} strokeWidth={3}/>}</button>
          <button className={`card-favorite ${state.favorites.includes(theme.id) ? 'saved' : ''}`} aria-label={`${state.favorites.includes(theme.id) ? '取消收藏' : '收藏'} ${theme.title}`} onClick={async () => merge(await window.yingchuang.favorite(theme.id))}><Heart size={16} fill={state.favorites.includes(theme.id) ? 'currentColor' : 'none'}/></button>
          <div className="card-caption"><h3 title={theme.title}>{theme.title}</h3>{theme.author && <span title={theme.author}>{theme.author}</span>}</div>
        </article>)}</div> : <div className="empty-state"><EmptyArt icon={search ? <Search size={30} strokeWidth={1.5}/> : page === 'favorites' ? <Heart size={30} strokeWidth={1.5}/> : <Images size={30} strokeWidth={1.5}/>}/><h2>{search ? '没有找到这张壁纸' : page === 'favorites' ? '把喜欢的壁纸放在这里' : '添加你的壁纸库'}</h2><p>{search ? '换个名称试试' : page === 'favorites' ? '点击封面上的爱心即可收藏' : '选择 Steam 或 Wallpaper Engine 目录'}</p>{page !== 'favorites' && !search && <button className="button primary" onClick={() => void addDirectory()}><Plus size={16}/>添加目录</button>}</div>}</div>
        {selected.size > 0 && <Glass className="selection-dock"><div className="selection-count"><span><CheckCheck size={17}/></span><b>已选 {selected.size} 项</b><button className="icon-button" aria-label="清空选择" onClick={() => { setSelected(new Set()); setSelecting(false); }}><X size={14}/></button></div><div className="dock-actions"><label className="template-select"><LayoutTemplate size={16}/><Select aria-label="批量排版模板" value={templateId} onChange={e => setTemplateId(e.target.value)}><option value="">各自排版</option>{state.templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label><DeviceSelect devices={state.devices} value={state.settings.deviceId} onChange={async value => merge(await window.yingchuang.settings({ deviceId: value }))}/><button className="button primary" disabled={starting} onClick={() => void convert()}>{starting ? <LoaderCircle size={16} className="spin"/> : <ArrowDownToLine size={16}/>}批量转换</button></div></Glass>}
      </>}
      {page === 'templates' && <div className="content-scroll"><div className="template-grid">{state.templates.map((template, index) => <Glass as="section" refraction={false} className="template-card" key={template.id} style={{ '--i': index } as React.CSSProperties}><TemplateThumbnail template={template}/><div className="template-caption"><div><h3>{template.name}</h3><span>{template.builtin ? '内置排版' : '我的排版'}</span></div>{!template.builtin && <button className="icon-button" aria-label={`删除模板 ${template.name}`} onClick={async () => { merge(await window.yingchuang.deleteTemplate(template.id)); notify('模板已删除', 'info'); }}><Trash2 size={16}/></button>}</div><button className="template-use" onClick={() => { setTemplateId(template.id); setSelecting(true); setPage('library'); notify('选择壁纸后即可批量套用', 'info'); }}>选择壁纸使用<ArrowUpRight size={15}/></button></Glass>)}</div><p className="quiet-note"><Info size={14}/>在编辑器中保存新排版，主题内容和原字体会各自保留。</p></div>}
      {page === 'queue' && <div className="content-scroll"><div className="queue-toolbar"><span>{state.queue.length} 个任务</span><div>{active > 0 && <button className="text-button" onClick={() => void window.yingchuang.cancelQueue()}>取消剩余</button>}<button className="text-button" onClick={() => void window.yingchuang.clearQueue()}>清空记录</button></div></div>{state.queue.length ? <div className="queue-list">{state.queue.map(item => { const theme = state.themes.find(t => t.id === item.themeId); const d = state.devices.find(d => d.id === item.deviceId); return <Glass as="section" refraction={false} className={`queue-item ${item.status}`} key={item.id}><div className="queue-cover">{theme && <img src={theme.preview} alt=""/>}</div><div className="queue-info"><h3>{item.title}</h3><p><span>{d?.name}</span><span>{d?.width} × {d?.height}</span>{item.mode && <span className="queue-mode">{item.mode === 'record' ? '录制模式' : '图层模式'}</span>}{item.size ? <span>{(item.size / 1048576).toFixed(1)} MB</span> : null}</p>{item.status === 'running' && <div className="queue-progress"><span style={{ width: `${Math.max(3, item.progress)}%` }}/></div>}{item.status === 'error' && <p className="queue-error">{item.error}</p>}</div><div className="queue-status">{item.status === 'running' ? <><LoaderCircle size={13} className="spin"/>{item.phase} · {Math.round(item.progress)}%</> : item.status === 'done' ? <><CircleCheck size={14}/>已完成</> : item.status === 'error' ? <><CircleX size={14}/>未完成</> : item.status === 'waiting' ? <><Clock3 size={13}/>等待</> : <>已取消</>}</div><div className="queue-action">{item.status === 'done' ? <button className="icon-button" aria-label={`打开 ${item.title} 导出目录`} onClick={() => void window.yingchuang.openOutput(item.id)}><FolderOpen size={18}/></button> : ['waiting', 'running'].includes(item.status) ? <button className="icon-button" aria-label={`取消 ${item.title}`} onClick={() => void window.yingchuang.cancelQueue(item.id)}><X size={17}/></button> : null}</div></Glass>; })}</div> : <div className="empty-state"><EmptyArt icon={<ArrowDownToLine size={30} strokeWidth={1.5}/>}/><h2>还没有转换任务</h2><p>从壁纸库挑选喜欢的画面</p><button className="button secondary" onClick={() => setPage('library')}>浏览壁纸</button></div>}</div>}
      {page === 'settings' && <div className="content-scroll settings-page">
        <Glass as="section" refraction={false} className="settings-section"><h2>外观</h2>
          <div className="material-cards">{([['frosted', '磨砂玻璃', '柔和漫射，层次安静', CloudFog], ['liquid', '液态玻璃', '通透折射，边缘高光随指针流动', Droplets]] as const).map(([key, label, note, Icon]) => <button key={key} className="material-card" aria-pressed={appearance.material === key} onClick={() => void setAppearance({ material: key })}><div className={`material-preview ${key}`}><span className="mp-blob"/><span className="mp-panel"/><span className="mp-pill"/></div><b><Icon size={15}/>{label}</b><small>{note}</small></button>)}</div>
          <div className="settings-row"><div><h3>配色</h3><p>深色适合夜间编辑，跟随系统会随系统设置切换</p></div><Segmented label="配色" value={appearance.scheme} onChange={value => void setAppearance({ scheme: value })} options={[{ value: 'system', label: '跟随系统', icon: <SunMoon size={13}/> }, { value: 'light', label: '浅色', icon: <Sun size={13}/> }, { value: 'dark', label: '深色', icon: <Moon size={13}/> }]}/></div>
          <div className="settings-row"><div><h3>环境光</h3><p>以当前壁纸的封面作为界面底色，玻璃会折射出它的色彩</p></div><Toggle label="环境光" hideLabel checked={appearance.ambient} onChange={value => void setAppearance({ ambient: value })}/></div>
          <div className="settings-row"><div><h3>卡片密度</h3><p>紧凑模式一屏显示更多壁纸</p></div><Segmented label="卡片密度" value={appearance.density} onChange={value => void setAppearance({ density: value })} options={[{ value: 'comfortable', label: '舒展', icon: <LayoutGrid size={13}/> }, { value: 'compact', label: '紧凑', icon: <Grid3x3 size={13}/> }]}/></div>
        </Glass>
        <Glass as="section" refraction={false} className="settings-section"><h2>导出</h2><div className="settings-row"><div><h3>默认机型</h3><p>预览与导出使用相同尺寸</p></div><DeviceSelect devices={state.devices} value={state.settings.deviceId} onChange={async value => merge(await window.yingchuang.settings({ deviceId: value }))}/></div><div className="settings-row"><div><h3>保存位置</h3><p className="path-text" title={state.settings.outputDirectory}>{state.settings.outputDirectory}</p></div><button className="button secondary" onClick={async () => { const next = await window.yingchuang.chooseDirectory('output'); if (next) setState(next); }}><FolderOpen size={15}/>选择目录</button></div><div className="settings-row"><div><h3>转换方式</h3><p>场景壁纸默认图层模式，逐层还原特效并保留逐层感应；网页、应用与透视三维壁纸使用录制模式。可在编辑器“导出”中逐个调整</p></div><Sparkles size={18} color="var(--accent)"/></div></Glass>
        <Glass as="section" refraction={false} className="settings-section"><div className="settings-section-heading"><h2>壁纸目录</h2><button className="text-button" onClick={() => void addDirectory()}><Plus size={15}/>添加</button></div>{state.roots.map(root => <div className="directory-row" key={root}><FolderOpen size={18}/><div><span title={root}>{root}</span><small>自动发现</small></div></div>)}{state.settings.roots.map(root => <div className="directory-row" key={'manual-' + root}><FolderOpen size={18}/><div><span title={root}>{root}</span><small>手动添加</small></div><button className="icon-button" aria-label={`移除目录 ${root}`} onClick={async () => setState(await window.yingchuang.removeDirectory(root))}><X size={16}/></button></div>)}</Glass>
        <Glass as="section" refraction={false} className="settings-section"><h2>内置机型</h2><div className="device-grid">{state.devices.map(device => <div key={device.id}><MonitorSmartphone size={20} strokeWidth={1.4}/><span>{device.name}<small>{device.width} × {device.height}</small></span></div>)}</div></Glass>
        <UpdateSettingsSection updater={updater} version={state.version}/>
      </div>}
    </main>
    <UpdateDialog updater={updater}/>
    {editing && <Editor theme={editing} state={state} onClose={() => setEditing(null)} onState={merge} onConvert={() => setPage('queue')} onToast={notify}/>}
    {toast && <Glass key={toast.key} className={`toast ${toast.kind}`} role="status"><span className="toast-icon">{toast.kind === 'error' ? <X size={15} strokeWidth={2.6}/> : toast.kind === 'info' ? <Info size={15}/> : <Check size={15} strokeWidth={2.6}/>}</span>{toast.message}<span className="toast-timer"/></Glass>}
  </div></AppearanceContext.Provider>;
}
