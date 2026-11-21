// 壁纸库与我的收藏：筛选、搜索、多选；卡片标注预设、已导出与不可用；多选后可套用排版或转换。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Images, Heart, Search, Plus, RefreshCw, Check, X, CheckCheck, LoaderCircle, SlidersHorizontal, CheckSquare2, LayoutGrid, Grid3x3, ArrowDownToLine, CircleCheck, LayoutTemplate, Ban } from 'lucide-react';
import type { AppState, Theme } from '../types';
import { Glass, type Appearance } from '../appearance';
import { FadeImage, Segmented, TypeIcon, typeNames, type ToastAction, type ToastKind } from '../ui';
import { Select } from '../Select';

export function EmptyArt({ icon }: { icon: React.ReactNode }) { return <div className="empty-art"><span/><span>{icon}</span></div>; }
/** 液态玻璃下工具条右侧是一块悬浮的玻璃，卡片从它下面滚过；磨砂下保持普通排列。 */
function ToolGroup({ liquid, children }: { liquid: boolean; children: React.ReactNode }) {
  return liquid ? <Glass className="toolbar-right">{children}</Glass> : <div className="toolbar-right">{children}</div>;
}
const shortDate = (time: number) => new Date(time).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });

type Props = { state: AppState; favorites: boolean; search: string; appearance: Appearance; setAppearance: (patch: Partial<Appearance>) => void;
  merge: (value: Partial<AppState>) => void; setState: (state: AppState) => void; notify: (message: string, kind?: ToastKind, action?: ToastAction) => void;
  onEdit: (theme: Theme) => void; onHover: (id: string) => void; onAddDirectory: () => void; onShowBuilds: () => void; onCount: (count: number) => void };

export function LibraryPage({ state, favorites, search, appearance, setAppearance, merge, setState, notify, onEdit, onHover, onAddDirectory, onShowBuilds, onCount }: Props) {
  const [filter, setFilter] = useState('all'), [sort, setSort] = useState('recent'), [selected, setSelected] = useState(new Set<string>()), [selecting, setSelecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false), [starting, setStarting] = useState(false);
  const lastSelected = useRef(''), hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const themes = useMemo(() => {
    let items = state.themes.filter(t => (!favorites || state.favorites.includes(t.id)) && (filter === 'all' || t.type === filter) && t.title.toLowerCase().includes(search.toLowerCase()));
    if (sort === 'name') items = [...items].sort((a, b) => a.title.localeCompare(b.title, 'zh-CN'));
    return items;
  }, [state.themes, state.favorites, favorites, search, filter, sort]);
  useEffect(() => onCount(themes.length), [themes.length]);
  const counts = useMemo(() => {
    const result: Record<string, number> = { all: 0 };
    for (const t of state.themes) if (!favorites || state.favorites.includes(t.id)) { result.all++; result[t.type] = (result[t.type] || 0) + 1; }
    return result;
  }, [state.themes, state.favorites, favorites]);
  const builds = useMemo(() => new Map(state.builds.filter(build => build.deviceId === state.settings.deviceId).map(build => [build.themeId, build])), [state.builds, state.settings.deviceId]);
  const allSelected = themes.length > 0 && themes.every(t => selected.has(t.id));
  const chosen = [...selected].filter(id => state.themes.find(t => t.id === id)?.available);
  async function refresh() { setRefreshing(true); try { setState(await window.yingchuang.refresh()); notify('壁纸库已刷新', 'info'); } catch (e) { notify((e as Error).message, 'error'); } finally { setRefreshing(false); } }
  async function convert() {
    if (!chosen.length || starting) return;
    setStarting(true);
    try { merge({ queue: await window.yingchuang.enqueue({ ids: chosen }) }); setSelected(new Set()); setSelecting(false); notify(`已开始转换 ${chosen.length} 张壁纸`, 'info', { label: '查看', run: onShowBuilds }); }
    catch (e) { notify((e as Error).message, 'error'); } finally { setStarting(false); }
  }
  async function applyTemplate(templateId: string) {
    const template = state.templates.find(t => t.id === templateId);
    if (!template || !chosen.length) return;
    try { setState(await window.yingchuang.applyTemplate(chosen, templateId)); notify(`已为 ${chosen.length} 张壁纸套用“${template.name}”`); } catch (e) { notify((e as Error).message, 'error'); }
  }
  function select(id: string, shift = false) {
    setSelected(old => {
      const next = new Set(old);
      if (shift && lastSelected.current) { const a = themes.findIndex(t => t.id === id), b = themes.findIndex(t => t.id === lastSelected.current); for (const t of themes.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(t.id); }
      else if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
    lastSelected.current = id;
  }
  function selectAll() { setSelected(old => { const next = new Set(old); for (const theme of themes) { if (allSelected) next.delete(theme.id); else next.add(theme.id); } return next; }); setSelecting(!allSelected); }
  function open(theme: Theme) {
    if (theme.available) { onEdit(theme); return; }
    notify(theme.reason || '这张壁纸暂时无法转换', 'info', theme.preset?.missing ? { label: '在 Steam 打开原壁纸', run: () => void window.yingchuang.openWorkshop(theme.preset!.base) } : undefined);
  }
  function hover(id: string) { clearTimeout(hoverTimer.current); hoverTimer.current = setTimeout(() => onHover(id), 260); }
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (document.querySelector('.modal-backdrop')) return;
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((event.target as HTMLElement)?.tagName);
      if (typing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); setSelected(new Set(themes.map(t => t.id))); setSelecting(true); }
      if (event.key === 'Escape') { setSelected(new Set()); setSelecting(false); }
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void convert(); }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  }, [themes, selected]);
  const deviceName = state.devices.find(d => d.id === state.settings.deviceId)?.name || '';
  const filterOptions = [['all', '全部'], ['scene', '场景'], ['video', '视频'], ['web', '网页'], ['application', '应用']].filter(([key]) => key === 'all' || counts[key])
    .map(([value, label]) => ({ value, label, count: counts[value] || 0, icon: value === 'all' ? undefined : <TypeIcon type={value} size={13}/> }));
  return <>
    <div className="library-toolbar"><Segmented label="壁纸类型" value={filter} onChange={setFilter} options={filterOptions}/>
      <ToolGroup liquid={appearance.material === 'liquid'}><button className={`text-button ${selecting ? 'is-selected' : ''}`} onClick={() => { setSelecting(!selecting); if (selecting) setSelected(new Set()); }}><CheckSquare2 size={15}/>{selecting ? '完成选择' : '多选'}</button>
        {selecting && <button className="text-button" onClick={selectAll}>{allSelected ? '取消全选' : '全选'}</button>}<span className="toolbar-divider"/>
        <button className="icon-button" title={appearance.density === 'compact' ? '大卡片' : '紧凑卡片'} aria-label={appearance.density === 'compact' ? '切换为大卡片' : '切换为紧凑卡片'} onClick={() => setAppearance({ density: appearance.density === 'compact' ? 'comfortable' : 'compact' })}>{appearance.density === 'compact' ? <LayoutGrid size={16}/> : <Grid3x3 size={16}/>}</button>
        <label className="sort-select"><Select aria-label="壁纸排序" value={sort} onChange={e => setSort(e.target.value)}><option value="recent">最近添加</option><option value="name">名称排序</option></Select></label>
        <button className="icon-button" title="刷新壁纸库" aria-label="刷新壁纸库" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={16} className={refreshing ? 'spin' : ''}/></button></ToolGroup></div>
    <div className={`library-scroll ${selected.size ? 'with-dock' : ''}`}>{themes.length ? <div className="wallpaper-grid">{themes.map((theme, index) => { const build = builds.get(theme.id); return <article className={`wallpaper-card ${selected.has(theme.id) ? 'selected' : ''} ${selecting ? 'selection-mode' : ''} ${theme.available ? '' : 'unavailable'}`} key={theme.id} style={{ '--i': index } as React.CSSProperties} data-testid={`theme-${theme.workshopId || theme.id}`} onMouseEnter={() => hover(theme.id)}>
      <button className="card-picture" aria-label={`编辑 ${theme.title}`} onClick={e => { if (selecting || e.ctrlKey || e.metaKey || e.shiftKey) { select(theme.id, e.shiftKey); setSelecting(true); } else open(theme); }}>
        <FadeImage src={theme.preview} alt={theme.title}/><span className="card-shade"/><span className="card-sheen"/>
        <span className="card-tags">{theme.type && <span className="card-type"><TypeIcon type={theme.type}/>{typeNames[theme.type] || theme.type}</span>}{theme.preset && <span className="card-type" title={`原壁纸：${theme.preset.baseTitle || theme.preset.base}`}>预设</span>}
          {build && <span className="card-type exported" title={`${deviceName} · ${shortDate(build.createdAt)} 导出`}><CircleCheck size={11}/>已导出</span>}
          {!theme.available && <span className="card-type blocked" title={theme.reason}><Ban size={11}/>{theme.preset?.missing ? '缺原壁纸' : '不可用'}</span>}</span>
        {theme.available && <span className="card-edit"><SlidersHorizontal size={13}/>编辑</span>}</button>
      <button className="card-select" aria-label={`${selected.has(theme.id) ? '取消选择' : '选择'} ${theme.title}`} aria-pressed={selected.has(theme.id)} onClick={e => { select(theme.id, e.shiftKey); setSelecting(true); }}>{selected.has(theme.id) && <Check size={14} strokeWidth={3}/>}</button>
      <button className={`card-favorite ${state.favorites.includes(theme.id) ? 'saved' : ''}`} aria-label={`${state.favorites.includes(theme.id) ? '取消收藏' : '收藏'} ${theme.title}`} onClick={async () => merge(await window.yingchuang.favorite(theme.id))}><Heart size={16} fill={state.favorites.includes(theme.id) ? 'currentColor' : 'none'}/></button>
      <div className="card-caption"><h3 title={theme.title}>{theme.title}</h3>{theme.author && <span title={theme.author}>{theme.author}</span>}</div>
    </article>; })}</div>
      : <div className="empty-state"><EmptyArt icon={search ? <Search size={30} strokeWidth={1.5}/> : favorites ? <Heart size={30} strokeWidth={1.5}/> : <Images size={30} strokeWidth={1.5}/>}/>
        <h2>{search ? '没有找到这张壁纸' : favorites ? '把喜欢的壁纸放在这里' : '添加你的壁纸库'}</h2><p>{search ? '换个名称试试' : favorites ? '点击封面上的爱心即可收藏' : '选择 Steam 或 Wallpaper Engine 目录'}</p>
        {!favorites && !search && <button className="button primary" onClick={onAddDirectory}><Plus size={16}/>添加目录</button>}</div>}</div>
    {selected.size > 0 && <Glass className="selection-dock"><div className="selection-count"><span><CheckCheck size={17}/></span><b>已选 {selected.size} 张</b><button className="icon-button" aria-label="清空选择" onClick={() => { setSelected(new Set()); setSelecting(false); }}><X size={14}/></button></div>
      <div className="dock-actions"><label className="template-select"><LayoutTemplate size={16}/><Select aria-label="套用排版模板" value="" disabled={!chosen.length} onChange={e => void applyTemplate(e.target.value)}><option value="" disabled>套用排版</option>{state.templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></label>
        <button className="button primary" disabled={starting || !chosen.length} onClick={() => void convert()}>{starting ? <LoaderCircle size={16} className="spin"/> : <ArrowDownToLine size={16}/>}转换 {chosen.length} 张</button></div></Glass>}
  </>;
}
