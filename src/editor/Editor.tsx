// 编辑器：左侧手机画面与工具，右侧画面、组件、壁纸设置、图层、导出五页。改动自动保存，可撤销重做。
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, FolderOpen, Undo2, Redo2, ArrowDownToLine, Sparkles, LoaderCircle, CircleCheck, Clock3, Crop, LayoutGrid, SlidersHorizontal, Layers, TriangleAlert } from 'lucide-react';
import type { AppState, Build, FontOption, Project, Property, SourceLayer, Template, Theme, ThemeDetail, WidgetKey } from '../types';
import { Glass } from '../appearance';
import { Segmented, TypeIcon, typeNames, type ToastKind } from '../ui';
import { model } from './model';
import { useProject } from './useProject';
import { cleanError, usePreview } from './usePreview';
import { Stage } from './Stage';
import { FramingPanel } from './FramingPanel';
import { WidgetsPanel } from './WidgetsPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { LayersPanel } from './LayersPanel';
import { ExportPanel } from './ExportPanel';
import '../updater.css';

type Tab = 'framing' | 'widgets' | 'properties' | 'layers' | 'export';
// 壁纸自带的时间模式（如“自选时间段”）会让画面不跟时钟走；开启随时间变化时把这类设置切到跟随现实时间。
const timeSetting = /时间|时段|昼夜|time|day|night/i, realTime = /(现实|真实|系统|实际|当前)时间|跟随时间|随时间变化|real[\s-]?time|system time|current time|follow.*time/i;
/** 壁纸的时间设置项：标签像时间设置，并且带“跟随现实时间”的选项，或本身就是跟随现实时间的开关 */
const isTimeProperty = (property: Property) => timeSetting.test(property.label)
  && (property.type === 'combo' ? Boolean(property.options?.some(option => realTime.test(option.label))) : property.type === 'bool' && realTime.test(property.label));
function realTimeChanges(properties: Property[], values: Record<string, unknown>) {
  const changes: { key: string; value: unknown; text: string }[] = [];
  for (const property of properties.filter(isTimeProperty)) {
    const current = values[property.key] ?? property.value;
    const option = property.type === 'combo' ? property.options?.find(option => realTime.test(option.label)) : undefined;
    if (option && String(option.value) !== String(current)) changes.push({ key: property.key, value: option.value, text: `${property.label} → ${option.label}` });
    if (property.type === 'bool' && current !== true) changes.push({ key: property.key, value: true, text: `${property.label} → 开启` });
  }
  return changes;
}
/** 显示本由时间设置切换、却在图层页被固定了显示的图层：随时间变化时它们会挡住按时段切换的画面 */
function pinnedTimeLayers(data: ThemeDetail, project: Project) {
  const keys = new Set(data.properties.filter(isTimeProperty).map(property => property.key));
  return data.detail.layers.filter(layer => layer.visibleProperty && keys.has(layer.visibleProperty) && project.layers[layer.id]?.visible !== undefined);
}
/** 去掉这些图层的显示覆盖，位置、透明度等其他调整保留 */
function releaseLayers(project: Project, layers: SourceLayer[]) {
  for (const layer of layers) {
    const { visible: _, ...rest } = project.layers[layer.id] ?? {};
    if (Object.keys(rest).length) project.layers[layer.id] = rest; else delete project.layers[layer.id];
  }
}
const typing = (target: EventTarget | null) => ['INPUT', 'TEXTAREA', 'SELECT'].includes((target as HTMLElement)?.tagName) || Boolean((target as HTMLElement)?.isContentEditable);

type Props = { theme: Theme; state: AppState; onClose: () => void; onState: (value: Partial<AppState>) => void; onToast: (message: string, kind?: ToastKind) => void };

export function Editor({ theme, state, onClose, onState, onToast }: Props) {
  const device = state.devices.find(d => d.id === state.settings.deviceId) || state.devices[state.devices.length - 1];
  const [data, setData] = useState<ThemeDetail | null>(null), [loadError, setLoadError] = useState('');
  const history = useProject(theme.id), project = history.project;
  const [tab, setTab] = useState<Tab>('framing'), [selection, setSelection] = useState<WidgetKey[]>([]), [layerId, setLayerId] = useState('');
  const [fonts, setFonts] = useState<FontOption[]>([]), [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [templatePreview, setTemplatePreview] = useState<Template | null>(null), [focusFont, setFocusFont] = useState<WidgetKey | null>(null);
  const [playing, setPlaying] = useState(true), [tilt, setTilt] = useState(false), [mask, setMask] = useState(() => localStorage.getItem('yingchuang-camera-mask') !== 'false');
  const [minute, setMinute] = useState<number | null>(null), [timeNotice, setTimeNotice] = useState(false);
  const [task, setTask] = useState<{ at: number; revision: number } | null>(null), [starting, setStarting] = useState(false);
  const closing = useRef(false), noticeDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { localStorage.setItem('yingchuang-camera-mask', String(mask)); }, [mask]);
  useEffect(() => { if (timeNotice) noticeDialog.current?.showModal(); else noticeDialog.current?.close(); }, [timeNotice]);
  useEffect(() => {
    let alive = true;
    void window.yingchuang.detail(theme.id).then(value => {
      if (!alive) return;
      setData(value); history.load(value.project);
      setLayerId([...value.detail.layers].reverse().find(layer => layer.visible)?.id || '');
    }).catch(failure => { if (alive) setLoadError(cleanError(failure.message)); });
    void window.yingchuang.fonts().then(setFonts).catch(() => {});
    return () => { alive = false; };
  }, [theme.id]);
  const fullAvailable = Boolean(data?.live.available), nativeAvailable = Boolean(data?.detail.renderable);
  // full 为录制模式，native 为图层模式；场景壁纸两种模式都用实时渲染预览。
  const mode: 'full' | 'native' = fullAvailable && (project?.export.mode === 'record' || !nativeAvailable) ? 'full' : 'native';
  const liveView = mode === 'full' || (theme.type === 'scene' && fullAvailable);
  const shown = useMemo(() => project && templatePreview ? model.applyTemplate(project, templatePreview) : project, [project, templatePreview]);
  const preview = usePreview({ theme, data, project: shown, deviceId: device.id, liveView, native: nativeAvailable });
  const update = history.update;
  useEffect(() => { if (tab === 'layers' && data?.detail.layers.length && !Object.keys(thumbnails).length) void window.yingchuang.layerThumbnails(theme.id).then(setThumbnails).catch(() => {}); }, [tab, Boolean(data)]);
  useEffect(() => { if (tab === 'widgets' && !selection.length && project?.widgets.length) setSelection([project.widgets[0].key]); }, [tab, Boolean(project)]);

  /** 关闭只等落盘，不受加载或转换状态影响 */
  async function close() {
    if (closing.current) return;
    closing.current = true;
    try { await history.flush(); } catch (failure) { onToast('保存失败：' + cleanError((failure as Error).message), 'error'); }
    onClose();
  }
  async function convert() {
    if (!project || starting) return;
    setStarting(true);
    try { await history.flush(); onState({ queue: await window.yingchuang.enqueue({ ids: [theme.id] }) }); setTask({ at: Date.now(), revision: history.revision }); }
    catch (failure) { onToast(cleanError((failure as Error).message), 'error'); }
    finally { setStarting(false); }
  }
  const pinned = data && project ? pinnedTimeLayers(data, project) : [];
  const releasePinned = () => { update(p => releaseLayers(p, pinned)); onToast(`已恢复 ${pinned.length} 个时段图层由壁纸按时间显示`, 'info'); };
  const enableTimeVariation = () => {
    const changes = data && project ? realTimeChanges(data.properties, project.properties) : [];
    update(p => { p.export.timeVariation = true; for (const change of changes) p.properties[change.key] = change.value; releaseLayers(p, pinned); });
    const setting = changes.length ? `已把壁纸的时间设置改为跟随现实时间（${changes.map(change => change.text).join('；')}）` : '';
    const layers = pinned.length ? `${setting ? '，并' : '已'}恢复 ${pinned.length} 个时段图层由壁纸按时间显示` : '';
    if (setting || layers) onToast(setting + layers, 'info');
  };
  const toggleTime = (on: boolean) => {
    if (on && !state.settings.timeVariationNotice) { setTimeNotice(true); return; }
    if (on) enableTimeVariation(); else { update(p => { p.export.timeVariation = false; }); setMinute(null); }
  };
  const confirmTime = async () => { setTimeNotice(false); enableTimeVariation(); onState(await window.yingchuang.settings({ timeVariationNotice: true })); };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.defaultPrevented || timeNotice) return;
      const mod = event.ctrlKey || event.metaKey, key = event.key.toLowerCase();
      if (event.key === 'Escape') { event.preventDefault(); void close(); return; }
      if (typing(event.target)) return;
      if (mod && key === 'z') { event.preventDefault(); if (event.shiftKey) history.redo(); else history.undo(); return; }
      if (mod && key === 'y') { event.preventDefault(); history.redo(); return; }
      if (mod && event.key === 'Enter') { event.preventDefault(); void convert(); return; }
      if (event.key === ' ' && (event.target as HTMLElement)?.tagName !== 'BUTTON') { event.preventDefault(); setPlaying(value => !value); return; }
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (arrows[event.key] && selection.length && tab !== 'layers') {
        event.preventDefault();
        const [dx, dy] = arrows[event.key], step = event.shiftKey ? 10 : 1;
        update(p => { for (const item of p.widgets) if (selection.includes(item.key)) { item.x = Math.max(0, Math.min(1, item.x + dx * step / device.width)); item.y = Math.max(0, Math.min(1, item.y + dy * step / device.height)); } }, 'nudge');
      }
    };
    document.addEventListener('keydown', listener); return () => document.removeEventListener('keydown', listener);
  });

  const item = task ? state.queue.filter(entry => entry.themeId === theme.id && entry.createdAt >= task.at - 2000).at(-1) : undefined;
  const stale = task !== null && history.revision !== task.revision;
  const build: Build | undefined = state.builds.find(entry => entry.themeId === theme.id && entry.deviceId === device.id);
  // 录制模式靠实时画面录制，画面载入失败时无法转换。
  const canConvert = Boolean(project) && (mode === 'full' ? fullAvailable && !(liveView && preview.error && !preview.liveReady) : nativeAvailable);
  const tabs = [{ value: 'framing', label: '画面', icon: <Crop size={14}/> }, { value: 'widgets', label: '组件', icon: <LayoutGrid size={14}/> },
    ...(data && (data.properties.some(p => p.type !== 'text') || theme.type === 'video') ? [{ value: 'properties', label: '壁纸设置', icon: <SlidersHorizontal size={14}/> }] : []),
    ...(data?.detail.layers.length ? [{ value: 'layers', label: '图层', icon: <Layers size={14}/> }] : []),
    { value: 'export', label: '导出', icon: <ArrowDownToLine size={14}/> }] as { value: Tab; label: string; icon: React.ReactNode }[];
  const running = item && (item.status === 'running' || item.status === 'waiting');
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) void close(); }}>
    <Glass as="section" className="editor" role="dialog" aria-modal="true" aria-label={`编辑 ${theme.title}`}>
      <header className="editor-header"><div className="editor-title"><img className="editor-cover" src={theme.preview} alt=""/><div><h2 title={theme.title}>{theme.title}</h2>
        <div className="editor-meta"><span className="type-chip"><TypeIcon type={theme.type} size={11}/>{typeNames[theme.type] || theme.type}</span>
          {theme.preset && <span className="type-chip preset" title={`原壁纸：${theme.preset.baseTitle}`}>预设 · {theme.preset.baseTitle}</span>}
          {theme.author && <span>{theme.author}</span>}{data?.detail.sourceSize && <span>{data.detail.sourceSize[0]} × {data.detail.sourceSize[1]}</span>}{theme.propertyCount > 0 && <span>{theme.propertyCount} 项壁纸设置</span>}</div></div></div>
        <div className="editor-header-actions"><button className="icon-button" title="打开壁纸目录" aria-label="打开壁纸目录" onClick={() => void window.yingchuang.openTheme(theme.id)}><FolderOpen size={17}/></button>
          <button className="icon-button" aria-label="关闭编辑器" onClick={() => void close()}><X size={19}/></button></div></header>
      <div className="editor-body"><div className="preview-panel">
        <div className="preview-glow" style={{ backgroundImage: `url("${theme.preview}")` }}/>
        <Stage theme={theme} data={data} project={shown} device={device} loadError={loadError} mode={mode} switchable={fullAvailable && nativeAvailable} liveView={liveView}
          onMode={value => update(p => { p.export.mode = value; })} timeVariation={project?.export.timeVariation === true} onTimeVariation={toggleTime} preview={preview}
          pinned={pinned.length ? { count: pinned.length, property: data?.properties.find(p => p.key === pinned[0].visibleProperty)?.label || '', onRelease: releasePinned } : undefined}
          playing={playing} onPlaying={setPlaying} tilt={tilt} onTilt={setTilt} mask={mask} onMask={setMask} minute={minute} onMinute={setMinute}
          selection={selection} onSelect={keys => { setSelection(keys); if (keys.length && tab !== 'widgets') setTab('widgets'); }} onUpdate={update}
          layers={tab === 'layers' && data ? { items: data.detail.layers, selected: layerId, onPick: setLayerId } : undefined}
          onFontWarning={key => { setTab('widgets'); setSelection([key]); setFocusFont(key); }}/>
      </div><aside className="inspector">
        <Segmented className="inspector-tabs" glass={false} label="编辑分类" value={tab} onChange={setTab} options={tabs}/>
        {!project || !data ? <div className="inspector-loading">{loadError ? <TriangleAlert size={20}/> : <LoaderCircle className="spin" size={20}/>}</div> : <div className="inspector-scroll" key={tab}>
          {tab === 'framing' && <FramingPanel project={project} update={update} templates={state.templates} onPreviewTemplate={setTemplatePreview}
            onApplyTemplate={template => { update(p => { Object.assign(p, model.applyTemplate(p, template)); }); onToast(`已套用“${template.name}”`, 'info'); }}
            onSaveTemplate={async name => { onState(await window.yingchuang.saveTemplate(name, project)); onToast('排版模板已保存'); }}/>}
          {tab === 'widgets' && <WidgetsPanel project={project} update={update} data={data} fonts={fonts} onFonts={setFonts} selection={selection} onSelect={setSelection} focusFont={focusFont} onFocused={() => setFocusFont(null)}/>}
          {tab === 'properties' && <PropertiesPanel theme={theme} data={data} project={project} update={update}/>}
          {tab === 'layers' && <LayersPanel data={data} project={project} update={update} fonts={fonts} onFonts={setFonts} selected={layerId} onSelect={setLayerId} thumbnails={thumbnails}/>}
          {tab === 'export' && <ExportPanel data={data} project={project} update={update} device={device} mode={mode} build={build}/>}
        </div>}
      </aside></div>
      <footer className="editor-footer"><div className="footer-left">
        <button className="icon-button" aria-label="撤销" title="撤销（Ctrl+Z）" disabled={!history.canUndo} onClick={history.undo}><Undo2 size={16}/></button>
        <button className="icon-button" aria-label="重做" title="重做（Ctrl+Shift+Z）" disabled={!history.canRedo} onClick={history.redo}><Redo2 size={16}/></button>
      </div>
        <div className="footer-actions">
          {item?.status === 'error' && !stale && <span className="task-state error" title={item.error}><TriangleAlert size={14}/>未完成：{item.error}</span>}
          {item?.status === 'done' && !stale && <button className="task-state done" title="在文件夹中显示" onClick={() => item.buildId && void window.yingchuang.showBuild(item.buildId)}><CircleCheck size={14}/>已导出 · {((item.size || 0) / 1048576).toFixed(1)} MB<FolderOpen size={13}/></button>}
          {running ? <><button className="button primary converting" disabled><LoaderCircle className="spin" size={16}/>{item!.status === 'waiting' ? '等待中' : `${item!.phase} · ${Math.round(item!.progress)}%`}<span className="convert-progress" style={{ width: `${Math.max(3, item!.progress)}%` }}/></button>
            <button className="icon-button" aria-label="取消转换" title="取消转换" onClick={() => void window.yingchuang.cancelQueue(item!.id)}><X size={16}/></button></>
            : <button className="button primary" disabled={!canConvert || starting} title="Ctrl+Enter" onClick={() => void convert()}>{starting ? <LoaderCircle className="spin" size={16}/> : mode === 'full' ? <Sparkles size={16}/> : <ArrowDownToLine size={16}/>}{item?.status === 'done' && !stale ? '再次转换' : '转换壁纸'}</button>}
        </div></footer>
    </Glass>
    <dialog ref={noticeDialog} className="updater-overlay time-notice" aria-labelledby="time-notice-title" onCancel={event => { event.preventDefault(); setTimeNotice(false); }}>
      <Glass className="updater-dialog" refraction={false}>
        <header className="update-header"><div className="update-emblem"><Clock3 size={23}/></div><div><h2 id="time-notice-title">随时间变化（实验）</h2></div></header>
        <div className="update-body update-notes"><p>导出时按一天中的多个时刻分别渲染，背屏按系统时间切换昼夜画面。</p><p>导出时间和包体会增加；切换较快的时段可能采不到。</p></div>
        <footer className="update-footer"><div className="update-actions update-actions-end"><button className="button secondary" onClick={() => setTimeNotice(false)}>取消</button><button className="button primary" onClick={() => void confirmTime()}>开启</button></div></footer>
      </Glass>
    </dialog>
  </div>;
}
