import { useEffect, useRef, useState } from 'react';
import { Images, Heart, Package, Settings2, Search, X, Minus, Square, Check, Info, CloudFog, Droplets, Sun, Moon, SunMoon, LoaderCircle, FolderOpen } from 'lucide-react';
import type { AppState, Theme } from './types';
import { Editor } from './editor/Editor';
import { AppearanceContext, Glass, defaultAppearance, useApplyAppearance, type Appearance } from './appearance';
import { Ambient, Logo, useNavIndicator, type ToastAction, type ToastKind } from './ui';
import { useUpdater, UpdateBadge, UpdateDialog } from './Updater';
import { LibraryPage } from './pages/Library';
import { BuildsPage } from './pages/Builds';
import { SettingsPage } from './pages/Settings';

type Page = 'library' | 'favorites' | 'builds' | 'settings';
const titles: Record<Page, string> = { library: '壁纸库', favorites: '我的收藏', builds: '成品', settings: '设置' };

export function App() {
  const [state, setState] = useState<AppState | null>(null), [page, setPage] = useState<Page>('library'), [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Theme | null>(null), [hovered, setHovered] = useState(''), [count, setCount] = useState(0);
  const [toast, setToast] = useState<{ message: string; kind: ToastKind; key: number; action?: ToastAction } | null>(null), [initialError, setInitialError] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), searchInput = useRef<HTMLInputElement>(null);
  const appearance: Appearance = { ...defaultAppearance, ...state?.settings.appearance };
  useApplyAppearance(appearance);
  const notify = (message: string, kind: ToastKind = 'success', action?: ToastAction) => {
    setToast({ message: message.replace(/^Error invoking remote method '[^']+': Error: /, ''), kind, key: Date.now(), action });
    clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(null), action ? 6000 : 3400);
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
    const queue = window.yingchuang.onQueue(items => setState(old => old ? { ...old, queue: items } : old));
    const builds = window.yingchuang.onBuilds(items => setState(old => old ? { ...old, builds: items } : old));
    const library = window.yingchuang.onLibrary(next => setState(old => old ? { ...next, queue: old.queue } : next));
    return () => { queue(); builds(); library(); };
  }, []);
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (editing || !(page === 'library' || page === 'favorites')) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); searchInput.current?.focus(); searchInput.current?.select(); }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [editing, page]);
  const nav = useNavIndicator(page);
  if (!state) return <main className="launch-screen"><Ambient image="" enabled={false}/><Logo/><h1>映窗</h1>{initialError ? <p>{initialError}</p> : <LoaderCircle className="spin" size={20}/>}</main>;
  const libraryPage = page === 'library' || page === 'favorites';
  const active = state.queue.filter(i => i.status === 'running' || i.status === 'waiting').length;
  const ambientImage = editing?.preview || state.themes.find(t => t.id === hovered)?.preview || state.themes.find(t => t.preview)?.preview || '';
  async function addDirectory() { const next = await window.yingchuang.chooseDirectory('library'); if (next) { setState(next); notify('已添加壁纸目录'); } }
  const schemeIcon = appearance.scheme === 'light' ? <Sun size={15}/> : appearance.scheme === 'dark' ? <Moon size={15}/> : <SunMoon size={15}/>;
  const schemeNext = { system: 'light', light: 'dark', dark: 'system' } as const, schemeName = { system: '跟随系统', light: '浅色', dark: '深色' };
  const subtitle = libraryPage ? `${count} 张壁纸${search ? ` · 搜索“${search}”` : ''}` : page === 'builds' ? (active ? `${active} 张正在转换` : `${state.builds.length} 个成品`) : '';
  return <AppearanceContext.Provider value={appearance}><div className="app-shell">
    <Ambient image={ambientImage} enabled={appearance.ambient}/>
    <div className="window-drag-region"/>
    <Glass className="window-controls" refraction={false}><button aria-label="最小化" onClick={() => void window.yingchuang.windowControl('minimize')}><Minus size={15}/></button><button aria-label="最大化" onClick={() => void window.yingchuang.windowControl('maximize')}><Square size={11}/></button><button aria-label="关闭应用" className="window-close" onClick={() => void window.yingchuang.windowControl('close')}><X size={16}/></button></Glass>
    <Glass as="aside" className="sidebar">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setPage('library'); }}><Logo/><span><b>映窗</b><small>背屏工作室</small></span></a>
      <nav className="main-nav" ref={nav.ref as React.RefObject<HTMLElement>}>{nav.indicator}{([['library', '壁纸库', Images], ['favorites', '我的收藏', Heart], ['builds', '成品', Package]] as const).map(([id, label, Icon]) => <button key={id} data-nav={id} className={page === id ? 'active' : ''} title={label} onClick={() => { setPage(id); setSearch(''); }}><Icon size={19} strokeWidth={1.7}/><span>{label}</span>{id === 'library' ? <small>{state.themes.length}</small> : id === 'favorites' && state.favorites.length ? <small>{state.favorites.length}</small> : id === 'builds' && active > 0 ? <small className="active-count">{active}</small> : null}</button>)}</nav>
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
    <main className="workspace">
      <header className="page-header"><div><h1>{titles[page]}</h1>{subtitle && <p>{subtitle}</p>}</div>
        <div className="page-actions">{libraryPage && <Glass className="search-field"><Search size={16}/><input ref={searchInput} placeholder="搜索壁纸" aria-label="搜索壁纸" value={search} onChange={e => setSearch(e.target.value)}/>{search ? <button className="icon-button" aria-label="清除搜索" onClick={() => setSearch('')}><X size={13}/></button> : <kbd>Ctrl F</kbd>}</Glass>}
          {page === 'builds' && <button className="button secondary" onClick={() => void window.yingchuang.openOutput()}><FolderOpen size={16}/>导出目录</button>}</div>
      </header>
      {libraryPage && <LibraryPage key={page} state={state} favorites={page === 'favorites'} search={search} appearance={appearance} setAppearance={patch => void setAppearance(patch)} merge={merge} setState={setState} notify={notify}
        onEdit={setEditing} onHover={id => { setHovered(id); if (!editing) void window.yingchuang.prefetch(id); }} onAddDirectory={() => void addDirectory()} onShowBuilds={() => setPage('builds')} onCount={setCount}/>}
      {page === 'builds' && <BuildsPage state={state} onState={merge} notify={notify} onBrowse={() => setPage('library')}/>}
      {page === 'settings' && <SettingsPage state={state} setState={setState} merge={merge} appearance={appearance} setAppearance={patch => void setAppearance(patch)} notify={notify} updater={updater} onAddDirectory={() => void addDirectory()}/>}
    </main>
    <UpdateDialog updater={updater}/>
    {editing && <Editor theme={editing} state={state} onClose={() => setEditing(null)} onState={merge} onToast={notify}/>}
    {toast && <Glass key={toast.key} className={`toast ${toast.kind}`} role="status"><span className="toast-icon">{toast.kind === 'error' ? <X size={15} strokeWidth={2.6}/> : toast.kind === 'info' ? <Info size={15}/> : <Check size={15} strokeWidth={2.6}/>}</span>
      <span className="toast-message">{toast.message}</span>{toast.action && <button className="toast-action" onClick={() => { toast.action!.run(); setToast(null); }}>{toast.action.label}</button>}<span className="toast-timer" style={{ animationDuration: toast.action ? '6s' : undefined }}/></Glass>}
  </div></AppearanceContext.Provider>;
}
