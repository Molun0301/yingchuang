import { Select } from './Select';
import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Play, Pause, MousePointer2, Move, RotateCcw, Save, SlidersHorizontal, Layers, LayoutTemplate, Check, AlignLeft, AlignCenter, AlignRight, Search, LoaderCircle, FolderOpen, Clock3, Sparkles, Music, ScanEye, Info, ChevronRight, TriangleAlert, ArrowDownToLine, Clapperboard, LayoutGrid, CalendarDays, Moon, Footprints, Route, Flame, Activity, Target, CloudSun, Thermometer, Droplets, Wind, Sunrise, Sunset, BatteryMedium, MessageSquare, PhoneMissed, Type } from 'lucide-react';
import type { AppState, Draft, ExportSettings, FontOption, Layout, Preview, RowKey, SourceLayer, Theme, ThemeDetail } from './types';
import type { LiveLoad, LivePatch } from './live/protocol';
import { PreviewCanvas } from './PreviewCanvas';
import { LiveStage, type LiveStageHandle } from './LiveStage';
import { ColorWell, PropertyControl, ResetButton, Slider, Toggle } from './controls';
import { colorHex, conditionVisible, sourceColor } from './conditions';
import { Glass } from './appearance';
import { Segmented, TypeIcon, typeNames, type ToastKind } from './ui';
import { frameScene, recordSize } from './live/framing';
import definitions from '../core/组件.json';

const rows = definitions.widgets.map(widget => widget.key);
const rowNames: Record<RowKey, string> = Object.fromEntries(definitions.widgets.map(widget => [widget.key, widget.name]));
const widgetIcons: Record<RowKey, typeof Clock3> = { time: Clock3, date: CalendarDays, week: CalendarDays, lunar: Moon, steps: Footprints, distance: Route, calories: Flame, active: Activity, goal: Target, weather: CloudSun, temperature: Thermometer, range: Thermometer, humidity: Droplets, air: Wind, sunrise: Sunrise, sunset: Sunset, battery: BatteryMedium, sms: MessageSquare, calls: PhoneMissed, text: Type };
const defaultExport: ExportSettings = { mode: 'layers', duration: 10, fps: 30, loop: true, fade: .6, quality: 'standard' };
const clockSignature = (draft: Draft) => JSON.stringify([draft.appearance, draft.layout.clock.enabled, draft.layout.clock.language, draft.layout.clock.seconds, draft.layout.clock.format, rows.map(k => { const r = draft.layout.clock.rows[k]; return [r.visible, r.label, r.text, r.size]; }), draft.deviceId]);
const cleanError = (message: string) => message.replace(/^Error invoking remote method '[^']+': Error: /, '');
type Tab = 'layout' | 'clock' | 'theme' | 'layers' | 'export';

/** 选择本地音乐后按左右声道各 64 段频谱推给渲染页，只用于预览音频响应效果 */
function useAudioPreview(url: string, playing: boolean, send: (left: number[], right: number[]) => void) {
  const element = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!url) return;
    const audio = new Audio(), context = new AudioContext();
    audio.crossOrigin = 'anonymous'; audio.src = url; audio.loop = true; element.current = audio;
    const source = context.createMediaElementSource(audio), splitter = context.createChannelSplitter(2);
    const analysers = [context.createAnalyser(), context.createAnalyser()];
    for (const analyser of analysers) { analyser.fftSize = 256; analyser.smoothingTimeConstant = .72; }
    source.connect(splitter); splitter.connect(analysers[0], 0); splitter.connect(analysers[1], 1); source.connect(context.destination);
    const buffers = [new Uint8Array(128), new Uint8Array(128)];
    const bands = (buffer: Uint8Array) => Array.from({ length: 64 }, (_, i) => {
      const from = Math.floor((i / 64) ** 1.6 * 120), to = Math.max(from + 1, Math.floor(((i + 1) / 64) ** 1.6 * 120));
      let peak = 0; for (let k = from; k < to; k++) peak = Math.max(peak, buffer[k]); return peak / 255;
    });
    let frame = 0;
    const tick = () => { frame = requestAnimationFrame(tick); analysers[0].getByteFrequencyData(buffers[0]); analysers[1].getByteFrequencyData(buffers[1]); send(bands(buffers[0]), bands(buffers[1])); };
    void context.resume().then(() => audio.play()).catch(() => {});
    tick();
    return () => { cancelAnimationFrame(frame); audio.pause(); audio.removeAttribute('src'); audio.load(); void context.close(); element.current = null; const silent = new Array(64).fill(0); send(silent, silent); };
  }, [url]);
  useEffect(() => { if (element.current) { if (playing) void element.current.play().catch(() => {}); else element.current.pause(); } }, [playing]);
}

export function Editor({ theme, state, onClose, onState, onConvert, onToast }: { theme: Theme; state: AppState; onClose: () => void; onState: (v: Partial<AppState>) => void; onConvert: () => void; onToast: (s: string, kind?: ToastKind) => void }) {
  const [data, setData] = useState<ThemeDetail | null>(null), [draft, setDraft] = useState<Draft | null>(null), [preview, setPreview] = useState<Preview | null>(null);
  const [tab, setTab] = useState<Tab>('layout'), [selected, setSelected] = useState<RowKey | null>('time');
  const [playing, setPlaying] = useState(true), [tilt, setTilt] = useState(false), [mask, setMask] = useState(() => localStorage.getItem('yingchuang-camera-mask') !== 'false');
  const [phase, setPhase] = useState('读取主题'), [busy, setBusy] = useState(true), [enhancing, setEnhancing] = useState(false), [error, setError] = useState('');
  const [fonts, setFonts] = useState<FontOption[]>([]), [propertySearch, setPropertySearch] = useState(''), [layerId, setLayerId] = useState('');
  const [templateName, setTemplateName] = useState(''), [naming, setNaming] = useState(false), [saving, setSaving] = useState(false);
  const [patch, setPatch] = useState<LivePatch | null>(null), [liveReady, setLiveReady] = useState(false), [diagnostics, setDiagnostics] = useState<string[]>([]);
  const [audioUrl, setAudioUrl] = useState(''), [dpr, setDpr] = useState(0), [loadMs, setLoadMs] = useState(0), [previewMinute, setPreviewMinute] = useState<number | null>(null);
  const alive = useRef(true), latest = useRef<Draft | null>(null), clockRequest = useRef(0), previewRequest = useRef(0), complete = useRef(false);
  const liveStage = useRef<LiveStageHandle>(null), screen = useRef<HTMLDivElement>(null), fontField = useRef<HTMLLabelElement>(null);
  const [focusFont, setFocusFont] = useState<RowKey | null>(null);
  useEffect(() => { localStorage.setItem('yingchuang-camera-mask', String(mask)); }, [mask]);
  latest.current = draft;
  const fullAvailable = Boolean(data?.live.available), nativeAvailable = Boolean(data?.detail.renderable);
  // full 为录制模式（实时完整画面），native 为图层模式（逐层转换并保留逐层感应）；默认图层模式。
  const mode: 'full' | 'native' = fullAvailable && (draft?.export?.mode === 'record' || !nativeAvailable) ? 'full' : 'native';
  const exportSettings: ExportSettings = { ...defaultExport, ...draft?.export };
  // 应用壁纸无法在页面中运行，预览显示封面，转换时启动程序录制窗口。
  const application = theme.type === 'application';
  useEffect(() => {
    alive.current = true;
    void window.yingchuang.detail(theme.id).then(value => { if (alive.current) { setData(value); setDraft({ ...value.draft, export: { ...defaultExport, ...value.draft.export } }); setLayerId(value.detail.layers.find(l => l.visible)?.id || ''); } }).catch(e => { setError(e.message); setBusy(false); });
    void window.yingchuang.fonts().then(setFonts).catch(() => {});
    const unsubscribe = window.yingchuang.onPreviewProgress(e => { if (e.id === theme.id && alive.current) setPhase(e.phase); });
    const ready = window.yingchuang.onPreviewReady(e => { if (e.id !== theme.id || e.requestId !== previewRequest.current || !alive.current) return; setEnhancing(false); if (e.error) { setError(e.error); return; } if (e.data) { complete.current = true; setPreview(p => ({ ...e.data!, clock: p?.clock ?? e.data!.clock, clockRoot: p?.clockRoot || e.data!.clockRoot })); } });
    return () => { alive.current = false; unsubscribe(); ready(); void window.yingchuang.cancelPreview(); };
  }, [theme.id]);
  // 原生图层：由转换核心生成与导出一致的分层预览。
  const graphicsKey = draft ? JSON.stringify([draft.properties, draft.layers, draft.layout.clock.enabled, draft.motion.fps]) : '';
  useEffect(() => {
    if (!draft || !data || mode !== 'native') return;
    if (!nativeAvailable) { setBusy(false); setError(data.detail.reason || '此类主题的背屏转换尚未接入。'); return; }
    const serial = ++previewRequest.current; setError('');
    // 已有完整动效时，修改设置不换成静态快速预览，保留当前画面直到新动效补齐，避免编辑中途特效消失。
    const keep = complete.current;
    if (keep) { setEnhancing(true); setBusy(false); } else { setBusy(true); setPhase('生成预览'); }
    const timer = setTimeout(() => {
      const snapshot = latest.current!;
      void window.yingchuang.preview(theme.id, snapshot, serial).then(async result => {
        if (!alive.current || serial !== previewRequest.current) return;
        if (keep && result.progressive) void window.yingchuang.previewMotion(theme.id, serial);
        else { complete.current = !result.progressive; setPreview(result); setEnhancing(Boolean(result.progressive)); }
        setError(result.clockError || '');
        if (clockSignature(snapshot) !== clockSignature(latest.current!)) {
          const update = await window.yingchuang.clock(theme.id, latest.current!); if (alive.current && serial === previewRequest.current) setPreview(p => p ? { ...p, ...update } : p);
        }
      }).catch(e => { if (alive.current && serial === previewRequest.current) { setBusy(false); if (!e.message.includes('已取消')) setError(e.message); } });
    }, preview && preview.layers.length ? 600 : 0);
    return () => clearTimeout(timer);
  }, [graphicsKey, Boolean(data), mode]);
  // 完整画面：画面来自实时渲染页，转换核心只负责时钟字形。
  useEffect(() => {
    complete.current = false;
    if (!data || mode !== 'full') return;
    ++previewRequest.current; void window.yingchuang.cancelPreview();
    setEnhancing(false); setBusy(!application); setError(''); setPhase('载入完整画面'); setDiagnostics(application ? ['应用壁纸会在转换时启动并录制窗口画面，预览显示封面。'] : []);
    setPreview(p => ({ width: data.live.sceneSize[0], height: data.live.sceneSize[1], title: theme.title, layers: [], restored: [], notes: [], assetRoot: 'live:' + theme.id,
      clockRoot: p?.clockRoot || '', clock: p?.clock || null, config: p?.config || {} }));
  }, [mode, Boolean(data)]);
  const layersKey = draft ? JSON.stringify(draft.layers) : '';
  useEffect(() => {
    if (!draft || mode !== 'full') return;
    const timer = setTimeout(() => void window.yingchuang.livePatch(theme.id, latest.current!).then(value => { if (alive.current) setPatch(value); }).catch(e => setError(e.message)), patch ? 260 : 0);
    return () => clearTimeout(timer);
  }, [layersKey, mode]);
  const clockKey = draft ? clockSignature(draft) + mode : '';
  useEffect(() => {
    if (!draft || !preview) return;
    const serial = ++clockRequest.current;
    const timer = setTimeout(() => {
      void window.yingchuang.clock(theme.id, latest.current!).then(result => { if (alive.current && serial === clockRequest.current) { setPreview(p => p ? { ...p, ...result } : p); if (mode === 'full') setError(''); } })
        .catch(e => { if (alive.current && serial === clockRequest.current) setError(e.message); });
    }, 450);
    return () => clearTimeout(timer);
  }, [clockKey, Boolean(preview)]);
  // 渲染分辨率与目标机型像素对齐，打开时计算一次；之后窗口缩放不再改倍率，避免实时画面整体重载。
  useEffect(() => {
    const node = screen.current;
    if (!node || dpr) return;
    const observer = new ResizeObserver(() => { if (node.clientWidth) setDpr(Math.min(2.5, Math.max(1, Math.round(device.width / node.clientWidth * 4) / 4))); });
    observer.observe(node); return () => observer.disconnect();
  }, [Boolean(draft), dpr]);
  async function finish(convert = false) {
    if (!draft || saving) return; setSaving(true);
    try { await window.yingchuang.saveDraft(theme.id, draft); if (convert) { await window.yingchuang.enqueue({ ids: [theme.id], deviceId: draft.deviceId }); onConvert(); onToast(`已加入转换队列 · ${mode === 'full' ? '录制模式' : '图层模式'}`, 'info'); } onClose(); }
    catch (e) { onToast((e as Error).message, 'error'); setSaving(false); }
  }
  const update = (fn: (d: Draft) => void) => setDraft(old => { if (!old) return old; const d = structuredClone(old); fn(d); return d; });
  const updateLayout = (layout: Layout) => update(d => { d.layout = layout; });
  const updateExport = (patch: Partial<ExportSettings>) => update(d => { d.export = { ...defaultExport, ...d.export, ...patch }; });
  const device = state.devices.find(d => d.id === draft?.deviceId) || state.devices[state.devices.length - 1];
  const row = selected || 'time', widget = definitions.widgets.find(widget => widget.key === row)!;
  const sourceNote = definitions.sources[widget.category as keyof typeof definitions.sources]?.note;
  const core = Boolean(widget.core);
  useEffect(() => {
    if (tab !== 'clock' || focusFont !== row) return;
    fontField.current?.querySelector<HTMLButtonElement>('[role=combobox]')?.focus();
    fontField.current?.scrollIntoView({ block: 'center' }); setFocusFont(null);
  }, [tab, row, focusFont]);
  const sourceLayer = data?.detail.layers.find(l => l.id === layerId);
  const layerValue = (key: string) => draft?.layers[layerId]?.[key] ?? sourceLayer?.[key as keyof SourceLayer];
  function changeLayer(key: string, value: unknown) { update(d => { d.layers[layerId] = { ...d.layers[layerId], [key]: value }; }); }
  const displayProperties = data?.properties.filter(p => p.type !== 'text' && conditionVisible(p.condition, draft?.properties || {}) && (!propertySearch || p.label.toLowerCase().includes(propertySearch.toLowerCase()))) || [];
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); void finish(); }
      if (e.key === ' ' && !['INPUT', 'TEXTAREA', 'BUTTON'].includes((e.target as HTMLElement)?.tagName)) { e.preventDefault(); setPlaying(p => !p); }
    };
    document.addEventListener('keydown', listener); return () => document.removeEventListener('keydown', listener);
  }, [draft]);
  const liveLoad: LiveLoad | null = useMemo(() => data && draft && patch && dpr && mode === 'full'
    ? { theme: data.live.theme, properties: draft.properties, patch, playing, dpr } : null, [data, draft?.properties, patch, mode, dpr]);
  useAudioPreview(mode === 'full' ? audioUrl : '', playing, (left, right) => liveStage.current?.audio(left, right));
  const recording = useMemo(() => {
    if (!draft || !data) return null;
    const framing = frameScene(data.live.sceneSize[0], data.live.sceneSize[1], device.width, device.height, draft.layout, draft.motion.amount, draft.motion.vertical);
    const size = recordSize(device.width, device.height, framing);
    const frames = Math.round(exportSettings.duration * exportSettings.fps);
    return { ...size, frames, megabytes: Math.max(.5, exportSettings.duration * 3.2 / 8 * size.width * size.height / 613000 * exportSettings.fps / 30) };
  }, [draft?.layout, draft?.motion, device, exportSettings.duration, exportSettings.fps, data]);
  const canConvert = mode === 'full' ? fullAvailable : nativeAvailable;
  // 随时段变化的图层带透明度关键点；有它们时显示预览时刻滑杆。
  const timed = mode === 'native' && Boolean(preview?.layers.some(layer => layer.time));
  const timeInfo = preview?.details?.['时段变化'] as { 对象数?: number; 变体数?: number } | undefined;
  const now = new Date(), nowMinute = Math.floor((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
  const clockText = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  const notes = mode === 'full' ? diagnostics : preview?.notes || [];
  const fontWarnings = preview?.clock?.warnings || [];
  const noteCount = notes.length + fontWarnings.length;
  const tabs = [{ value: 'layout', label: '排版', icon: <LayoutTemplate size={14}/> }, { value: 'clock', label: '组件', icon: <LayoutGrid size={14}/> }, { value: 'theme', label: '主题', icon: <SlidersHorizontal size={14}/> }, { value: 'layers', label: '图层', icon: <Layers size={14}/> }, { value: 'export', label: '导出', icon: <ArrowDownToLine size={14}/> }] as const;
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) void finish(); }}>
    <Glass as="section" className="editor" role="dialog" aria-modal="true" aria-label={`编辑 ${theme.title}`}>
      <header className="editor-header"><div className="editor-title"><img className="editor-cover" src={theme.preview} alt=""/><div><h2 title={theme.title}>{theme.title}</h2><div className="editor-meta"><span className="type-chip"><TypeIcon type={theme.type} size={11}/>{typeNames[theme.type] || theme.type}</span>{theme.author && <span>{theme.author}</span>}{data && theme.type === 'scene' && data.detail.sourceSize && <span>{data.detail.sourceSize[0]} × {data.detail.sourceSize[1]}</span>}{theme.propertyCount > 0 && <span>{theme.propertyCount} 项主题设置</span>}</div></div></div>
        <div className="editor-header-actions"><button className="icon-button" title="打开原主题目录" aria-label="打开原主题目录" onClick={() => void window.yingchuang.openTheme(theme.id)}><FolderOpen size={17}/></button><button className="icon-button" aria-label="关闭编辑器" onClick={() => void finish()}><X size={19}/></button></div></header>
      <div className="editor-body"><div className="preview-panel">
        <div className="preview-glow" style={{ backgroundImage: `url("${theme.preview}")` }}/>
        <div className="preview-heading">
          {fullAvailable && nativeAvailable ? <Segmented label="转换方式" value={mode} onChange={value => updateExport({ mode: value === 'full' ? 'record' : 'layers' })} options={[{ value: 'native', label: '图层模式', icon: <Layers size={13}/>, title: '逐层转换，背屏上每层独立感应视差，特效逐层完整渲染' }, { value: 'full', label: '录制模式', icon: <Clapperboard size={13}/>, title: '录制完整画面为循环视频，整幅随感应平移' }]}/>
            : <span className="type-chip">{mode === 'full' ? <><Clapperboard size={11}/>录制模式</> : theme.type === 'video' ? <><Clapperboard size={11}/>视频转码</> : <><Layers size={11}/>图层模式</>}</span>}
          <div className="device-compact"><Select aria-label="适配机型" value={device.id} onChange={e => update(d => { d.deviceId = e.target.value; })}>{state.devices.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</Select><span>{device.width} × {device.height}</span></div>
        </div>
        <div className="preview-stage"><div className="device-frame" style={{ '--screen-ratio': device.width / device.height } as React.CSSProperties}>
          <div className="screen" ref={screen} style={{ borderRadius: `${device.cornerRadius / device.width * 100}% / ${device.cornerRadius / device.height * 100}%`, backgroundImage: mode === 'full' && !liveReady ? `url("${theme.preview}")` : undefined }}>
            {mode === 'full' && data && !application && <LiveStage ref={liveStage} renderer={data.live.renderer} load={liveLoad} playing={playing}
              onReady={(_info, ms) => { setLiveReady(true); setBusy(false); setLoadMs(ms); }} onError={message => { setBusy(false); setError(message); }}
              onDiagnostic={message => setDiagnostics(old => old.includes(message) || old.length > 30 ? old : [...old, message])}/>}
            {mode === 'full' && application && <div className="live-frame live-poster" data-live-frame="" style={{ backgroundImage: `url("${theme.preview}")` }}/>}
            {draft ? <PreviewCanvas preview={preview} draft={draft} device={device} poster={theme.preview} playing={playing} tilt={tilt} mask={mask} selected={selected}
              live={mode === 'full' ? { ready: liveReady || application } : undefined} minute={previewMinute}
              onSelect={key => { setSelected(key); if (key) setTab('clock'); }} onLayout={updateLayout} onError={message => { setBusy(false); setError(message); }}
              onReady={() => { setBusy(false); if (preview?.progressive) void window.yingchuang.previewMotion(theme.id, previewRequest.current); }}/> : <img src={theme.preview} alt=""/>}
            {(busy || enhancing) && <div className="preview-status"><LoaderCircle size={13} className="spin"/>{busy ? phase : complete.current ? `正在更新${/逐层渲染/.test(phase) ? ' · ' + phase : '预览'}` : /逐层渲染/.test(phase) ? phase + '，可继续编辑' : '正在补齐动效，可继续编辑'}</div>}
            <div className="preview-badge">{mode === 'full' ? '录制模式' : '图层模式'} · {device.width}×{device.height}{mode === 'full' && loadMs ? ` · ${loadMs} ms` : ''}</div>
          </div>
        </div></div>
        <Glass className="preview-tools"><div><button className={`icon-button ${!playing ? 'active' : ''}`} aria-label={playing ? '暂停动效' : '播放动效'} title="播放 / 暂停（空格）" onClick={() => setPlaying(!playing)}>{playing ? <Pause size={17}/> : <Play size={17}/>}</button><span className="tool-divider"/><button className={`tool-button ${!tilt ? 'active' : ''}`} onClick={() => setTilt(false)}><Move size={15}/><span>排版</span></button><button className={`tool-button ${tilt ? 'active' : ''}`} onClick={() => setTilt(true)}><MousePointer2 size={15}/><span>感应</span></button><button className={`tool-button ${mask ? 'active' : ''}`} onClick={() => setMask(!mask)}><ScanEye size={15}/><span>避让区域</span></button>
          {timed && <><span className="tool-divider"/><label className="time-scrub" title="预览一天中不同时刻的画面"><Clock3 size={15}/><input type="range" aria-label="预览时刻" min={0} max={1425} step={15} value={previewMinute ?? nowMinute} onChange={e => setPreviewMinute(Number(e.target.value))}/><span>{clockText(previewMinute ?? nowMinute)}</span>{previewMinute !== null && <button className="icon-button" aria-label="回到当前时间" title="回到当前时间" onClick={() => setPreviewMinute(null)}><RotateCcw size={12}/></button>}</label></>}
          {mode === 'full' && <button className={`tool-button ${audioUrl ? 'active' : ''}`} title="选择本地音乐，预览壁纸的音频响应" onClick={async () => { if (audioUrl) { setAudioUrl(''); return; } const file = await window.yingchuang.chooseFile('audio-preview'); if (file) setAudioUrl(file); }}><Music size={15}/><span>{audioUrl ? '停止试听' : '试听音乐'}</span></button>}</div>
          <span className="tool-divider"/><span className="zoom-readout" title="滚轮缩放取景">{draft ? Math.round(draft.layout.scale * 100) : 100}%</span></Glass>
        {error && <div className="editor-error" role="status"><TriangleAlert size={15}/>{cleanError(error)}</div>}
        {noteCount > 0 && <details className="conversion-notes"><summary>转换说明 <span>{noteCount}</span></summary><ul>{notes.map((note, i) => <li key={i}>{note}</li>)}{fontWarnings.map((warning, i) => <li key={`${warning.key}-${i}`}>{warning.message} <button className="text-button" onClick={() => { setTab('clock'); setSelected(warning.key); setFocusFont(warning.key); }}>更换字体</button></li>)}</ul></details>}
      </div><aside className="inspector">
        <Segmented className="inspector-tabs" glass={false} label="编辑分类" value={tab} onChange={setTab} options={[...tabs]}/>
        {!draft || !data ? <div className="inspector-loading"><LoaderCircle className="spin" size={20}/></div> : <div className="inspector-scroll" key={tab}>
          {tab === 'layout' && <>
            <div className="inspector-section"><div className="section-title">画面<ResetButton label="重置取景" onClick={() => update(d => { d.layout.scale = 1.06; d.layout.x = .5; d.layout.y = .5; })}/></div>
              <Slider label="缩放" value={draft.layout.scale * 100} min={20} max={300} suffix="%" onChange={v => update(d => { d.layout.scale = v / 100; })}/>
              <div className="two-fields"><label>水平<input aria-label="水平取景" type="number" min={0} max={100} value={Math.round(draft.layout.x * 100)} onChange={e => update(d => { d.layout.x = Number(e.target.value) / 100; })}/></label><label>垂直<input aria-label="垂直取景" type="number" min={0} max={100} value={Math.round(draft.layout.y * 100)} onChange={e => update(d => { d.layout.y = Number(e.target.value) / 100; })}/></label></div>
              <Toggle label="水平翻转" checked={draft.layout.flip} onChange={v => update(d => { d.layout.flip = v; })}/>
              <div className="hint"><Info size={13}/>在预览上拖动调整取景，滚轮缩放；拖动组件可单独移动。</div>
            </div>
            <details className="inspector-section advanced" open><summary><ChevronRight size={14}/>感应与动效</summary><Slider label="感应幅度" value={draft.motion.amount * 100} min={0} max={10} step={.1} digits={1} suffix="%" onChange={v => update(d => { d.motion.amount = v / 100; })}/><Slider label="平滑程度" value={(1 - draft.motion.smoothing) * 100} min={0} max={98} suffix="%" onChange={v => update(d => { d.motion.smoothing = 1 - v / 100; })}/><label className="stack-field"><span>播放帧率</span><Select aria-label="播放帧率" value={draft.motion.fps} onChange={e => update(d => { d.motion.fps = Number(e.target.value); })}>{[15, 24, 30, 60, 120].map(n => <option key={n} value={n}>{n} 帧 / 秒</option>)}</Select></label></details>
          </>}
          {tab === 'clock' && <>
            <div className="inspector-section"><Toggle label="显示组件" checked={draft.layout.clock.enabled} onChange={async v => {
              let initialFont = '';
              if (v && !data.detail.fontIssue && !data.detail.fonts.length) { const available = fonts.length ? fonts : await window.yingchuang.fonts(); const regular = available.filter(f => !/Bold|Black|Italic|Heavy|粗|斜/i.test(f.label)); for (const pattern of [/MiSans/i, /Microsoft YaHei|微软雅黑/i, /Noto Sans CJK|思源黑体/i, /DejaVu Sans$/i]) { initialFont = regular.find(f => pattern.test(f.label))?.value || ''; if (initialFont) break; } initialFont ||= regular[0]?.value || available[0]?.value || ''; }
              update(d => { d.layout.clock.enabled = v; if (initialFont) for (const key of ['week', 'date', 'time']) if (!d.appearance.fonts[key]) d.appearance.fonts[key] = initialFont; });
            }}/>
            </div>
            <div className="widget-categories">{definitions.categories.map(category => <div className="widget-category" key={category.key}><h3>{category.name}</h3><div className="widget-grid">{definitions.widgets.filter(widget => widget.category === category.key).map(widget => { const visible = draft.layout.clock.rows[widget.key].visible, Icon = widgetIcons[widget.key]; return <button key={widget.key} className={`widget-card ${visible ? 'is-visible' : ''} ${row === widget.key ? 'is-selected' : ''}`} aria-label={`编辑${widget.name}组件`} aria-pressed={visible} onClick={() => { setSelected(widget.key); if (!visible) update(d => { d.layout.clock.rows[widget.key].visible = true; }); }}><Icon size={16}/><span>{widget.name}</span>{visible && <Check size={11}/>}</button>; })}</div></div>)}</div>
            <div className="inspector-section widget-settings"><div className="section-title">{widget.name}</div><>
                <Toggle label={`显示${rowNames[row]}`} checked={draft.layout.clock.rows[row].visible} onChange={v => update(d => { d.layout.clock.rows[row].visible = v; })}/>
                <div className="two-fields"><label>横向位置<input aria-label={`${rowNames[row]}横向位置`} type="number" min={0} max={100} value={Number((draft.layout.clock.rows[row].x * 100).toFixed(1))} onChange={e => update(d => { d.layout.clock.rows[row].x = Number(e.target.value) / 100; })}/></label><label>纵向位置<input aria-label={`${rowNames[row]}纵向位置`} type="number" min={0} max={100} value={Number((draft.layout.clock.rows[row].y * 100).toFixed(1))} onChange={e => update(d => { d.layout.clock.rows[row].y = Number(e.target.value) / 100; })}/></label></div>
                <label ref={fontField} className="stack-field"><span>字体</span><Select aria-label={`${rowNames[row]}字体`} value={draft.appearance.fonts[row]} onChange={async e => { const value = e.target.value; if (value === '__file') { const file = await window.yingchuang.chooseFile('font'); if (file) { setFonts(old => [{ value: file, label: file.split(/[\\/]/).pop() || file }, ...old]); update(d => { d.appearance.fonts[row] = file; }); } } else update(d => { d.appearance.fonts[row] = value; }); }}><option value="">{core ? '原主题字体' : '跟随时间字体'}</option>{data.detail.fonts.length > 0 && <optgroup label="主题内置字体">{data.detail.fonts.map((f, i) => <option key={i} value={f.value}>{f.label}</option>)}</optgroup>}<optgroup label="本机字体">{fonts.map((f, i) => <option key={i} value={f.value}>{f.label}</option>)}</optgroup><option value="__file">选择字体文件…</option></Select></label>
                <Slider label="字号" value={draft.layout.clock.rows[row].size} min={10} max={180} onChange={v => update(d => { d.layout.clock.rows[row].size = v; })}/>
                <div className="color-field"><span>颜色</span><div className="color-controls"><ColorWell label={`${rowNames[row]}颜色`} value={draft.appearance.colors[row] || (core ? data.detail.sourceColors?.[row] : draft.appearance.colors.time || data.detail.sourceColors?.time) || '#ffffff'} onChange={value => update(d => { d.appearance.colors[row] = value; })}/><ResetButton label={core ? '使用原主题颜色' : '跟随时间颜色'} onClick={() => update(d => { d.appearance.colors[row] = ''; })}/></div></div>
                <div className="alignment-field"><span>对齐</span><Segmented glass={false} label={`${rowNames[row]}对齐`} value={draft.layout.clock.rows[row].align} onChange={align => update(d => { d.layout.clock.rows[row].align = align; })} options={([['left', AlignLeft, '左对齐'], ['center', AlignCenter, '居中'], ['right', AlignRight, '右对齐']] as const).map(([value, Icon, title]) => ({ value, label: '', icon: <Icon size={15} aria-label={`${rowNames[row]}${title}`}/>, title }))}/></div>
                {widget.format && <Toggle label="显示单位与标签" checked={draft.layout.clock.rows[row].label !== false} onChange={v => update(d => { d.layout.clock.rows[row].label = v; })}/>}
                {row === 'text' && <label className="stack-field"><span>自定义文字</span><input aria-label="自定义文字" maxLength={40} value={draft.layout.clock.rows[row].text} onChange={e => update(d => { d.layout.clock.rows[row].text = [...e.target.value].slice(0, 40).join(''); })}/></label>}
                {sourceNote && <div className="hint widget-source"><Info size={13}/>{sourceNote}</div>}
                {row === 'week' && <label className="stack-field"><span>星期语言</span><Select aria-label="星期语言" value={draft.layout.clock.language} onChange={e => update(d => { d.layout.clock.language = e.target.value as 'en' | 'zh'; })}><option value="en">英文</option><option value="zh">中文</option></Select></label>}
                {row === 'time' && <><label className="stack-field"><span>时间格式</span><Select aria-label="时间格式" value={draft.layout.clock.format} onChange={e => update(d => { d.layout.clock.format = e.target.value as 'auto' | '24' | '12'; })}><option value="auto">跟随主题</option><option value="24">24 小时</option><option value="12">12 小时</option></Select></label><Toggle label="显示秒数" checked={draft.layout.clock.seconds} onChange={v => update(d => { d.layout.clock.seconds = v; })}/></>}
              </>
              {mode === 'full' && (data.detail.clockLayerIds?.length || 0) > 0 && <div className="hint"><Info size={13}/>原主题的时钟文字已隐藏，由背屏时钟实时显示，避免录制时把某一刻的时间固定在画面里。</div>}
            </div>
          </>}
          {tab === 'theme' && <><label className="inspector-search"><Search size={14}/><input placeholder="查找主题设置" value={propertySearch} onChange={e => setPropertySearch(e.target.value)}/></label>{theme.type === 'video' && <><Slider label="播放速度" value={Number(draft.properties.__videoSpeed ?? 1)} min={.25} max={2} step={.05} digits={2} suffix="×" onChange={v => update(d => { d.properties.__videoSpeed = v; })}/><Slider label="导出音量" value={Number(draft.properties.__videoVolume ?? 0) * 100} min={0} max={100} suffix="%" onChange={v => update(d => { d.properties.__videoVolume = v / 100; })}/></>}<div className="property-fields">{displayProperties.map(p => <PropertyControl key={p.key} property={p} value={draft.properties[p.key] ?? p.value} onChange={value => update(d => { d.properties[p.key] = value; })}/>)}{!displayProperties.length && <div className="empty-small">{propertySearch ? '没有匹配的设置' : '这张壁纸没有可调设置'}</div>}</div><button className="text-button" onClick={() => update(d => { d.properties = Object.fromEntries(data.properties.filter(p => 'value' in p).map(p => [p.key, p.value])); })}><RotateCcw size={13}/>恢复主题设置</button></>}
          {tab === 'layers' && (data.detail.layers.length ? <><label className="stack-field"><span>选择图层</span><Select aria-label="选择图层" value={layerId} onChange={e => setLayerId(e.target.value)}>{data.detail.layers.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></label>{sourceLayer && <><Toggle label="显示图层" checked={Boolean(layerValue('visible'))} onChange={v => changeLayer('visible', v)}/><Slider label="图层横向位置" value={Number(layerValue('x')) * 100} min={-100} max={200} suffix="%" onChange={v => changeLayer('x', v / 100)}/><Slider label="图层纵向位置" value={Number(layerValue('y')) * 100} min={-100} max={200} suffix="%" onChange={v => changeLayer('y', v / 100)}/><Slider label="图层缩放" value={Number(draft.layers[layerId]?.scale ?? 1) * 100} min={1} max={300} suffix="%" onChange={v => changeLayer('scale', v / 100)}/><Slider label="图层旋转" value={Number(draft.layers[layerId]?.rotation ?? 0)} min={-180} max={180} suffix="°" onChange={v => changeLayer('rotation', v)}/><Slider label="不透明度" value={Number(layerValue('alpha')) * 100} min={0} max={100} suffix="%" onChange={v => changeLayer('alpha', v / 100)}/><label className="color-field"><span>图层颜色</span><input aria-label="图层颜色" type="color" value={colorHex(layerValue('color'))} onChange={e => changeLayer('color', sourceColor(e.target.value))}/></label>{sourceLayer.kind === 'text' && <><label className="stack-field"><span>文字内容</span><textarea aria-label="文字内容" value={String(layerValue('text') ?? '')} onChange={e => changeLayer('text', e.target.value)}/></label><label className="stack-field"><span>图层字体</span><Select aria-label="图层字体" value={String(draft.layers[layerId]?.font || '')} onChange={async e => { const value = e.target.value; if (value === '__file') { const file = await window.yingchuang.chooseFile('font'); if (file) { setFonts(old => [{ value: file, label: file.split(/[\\/]/).pop() || file }, ...old]); changeLayer('font', file); } } else changeLayer('font', value); }}><option value="">原图层字体</option><optgroup label="主题内置字体">{data.detail.fonts.map((f, i) => <option key={i} value={f.value}>{f.label}</option>)}</optgroup><optgroup label="本机字体">{fonts.map((f, i) => <option key={i} value={f.value}>{f.label}</option>)}</optgroup><option value="__file">选择字体文件…</option></Select></label><Slider label="原图层字号" value={Number(layerValue('fontsize'))} min={8} max={160} onChange={v => changeLayer('fontsize', v)}/></>}<button className="text-button" onClick={() => update(d => { delete d.layers[layerId]; })}><RotateCcw size={13}/>恢复此图层</button></>}</> : <div className="empty-small">{theme.type === 'scene' ? '此场景按完整画面直接渲染，暂不提供逐层调整。' : '这类壁纸没有可编辑的图层。'}</div>)}
          {tab === 'export' && <>
            <div className="mode-cards">
              <button className="mode-card" aria-pressed={mode === 'native'} disabled={!nativeAvailable} onClick={() => updateExport({ mode: 'layers' })}>{theme.type === 'video' ? <Clapperboard/> : <Layers/>}<b>{theme.type === 'video' ? '视频转码' : '图层模式'}</b><small>{nativeAvailable ? theme.type === 'video' ? '保持原画质，可调播放速度与音量。' : '逐层转换，背屏上每层按景深独立感应视差。带特效、粒子或脚本动画的图层由渲染器逐层完整还原。' : data.detail.reason || '此主题无法按图层转换。'}</small></button>
              <button className="mode-card" aria-pressed={mode === 'full'} disabled={!fullAvailable} onClick={() => updateExport({ mode: 'record' })}><Sparkles/><b>录制模式</b><small>{fullAvailable ? '把完整画面录制为首尾无缝的循环视频，整幅随感应平移。适合网页、应用与透视三维壁纸。' : theme.type === 'video' ? '视频壁纸直接转码导出。' : theme.type === 'application' ? '应用壁纸需要在 Windows 上运行后录制。' : '此类壁纸不支持录制。'}</small></button>
            </div>
            <div className="inspector-section">
              <div className="section-title">画质</div>
              <Segmented glass={false} label="导出画质" value={exportSettings.quality} onChange={quality => updateExport({ quality })} options={[{ value: 'compact', label: '省空间' }, { value: 'standard', label: '标准' }, { value: 'high', label: '高清' }]}/>
              <div className="hint"><Info size={13}/>按背屏 {device.width}×{device.height} 的实际显示尺寸缩小贴图与视频，并裁掉屏幕和感应留边以外的部分。标准与屏幕像素一一对应；高清保留 1.5 倍细节；省空间约为 0.75 倍。</div>
            </div>
            {mode === 'native' && timed && <div className="hint"><Clock3 size={13}/>这张壁纸随现实时间变化{timeInfo?.变体数 ? `，共 ${timeInfo.变体数} 种时段画面` : ''}。导出后背屏按系统时间切换，渐变时段保留过渡；可在预览工具条拖动“预览时刻”查看各时段。</div>}
            {mode === 'full' && <div className="inspector-section">
              <div className="section-title">录制</div>
              <Slider label="循环时长" value={exportSettings.duration} min={2} max={30} suffix=" 秒" onChange={v => updateExport({ duration: v })}/>
              <div className="field-heading"><span>帧率</span></div>
              <Segmented glass={false} label="录制帧率" value={String(exportSettings.fps)} onChange={v => updateExport({ fps: Number(v) })} options={[24, 30, 60].map(n => ({ value: String(n), label: `${n} 帧` }))}/>
              <Toggle label="首尾交叉过渡" checked={exportSettings.loop} onChange={v => updateExport({ loop: v })}/>
              {exportSettings.loop && <Slider label="过渡时长" value={exportSettings.fade} min={.1} max={2} step={.1} digits={1} suffix=" 秒" onChange={v => updateExport({ fade: v })}/>}
              {recording && <div className="estimate"><span>{recording.width} × {recording.height}</span><span>{recording.frames} 帧 · 约 {recording.megabytes.toFixed(1)} MB</span></div>}
            </div>}
            <div className="hint"><Info size={13}/>{mode === 'full' ? '录制画面包含感应留边，倾斜手机时整幅画面平移。音频响应、鼠标交互与随现实时间变化的画面按录制时刻固定，需要随时段变化请使用图层模式。' : '每层动画按 4 秒循环烘焙，背屏系统逐层绘制并分别响应感应。全屏后期类效果无法拆到图层，记录在转换报告中。'}</div>
          </>}
        </div>}
      </aside></div>
      <footer className="editor-footer"><div className="footer-left">{naming ? <form className="template-name" onSubmit={async e => { e.preventDefault(); if (!draft) return; onState(await window.yingchuang.saveTemplate(templateName || '我的排版', draft.layout)); setNaming(false); onToast('排版模板已保存'); }}><input autoFocus aria-label="模板名称" placeholder="模板名称" value={templateName} onChange={e => setTemplateName(e.target.value)}/><button type="submit" className="icon-button" aria-label="保存模板"><Check size={17}/></button><button type="button" className="icon-button" aria-label="取消保存模板" onClick={() => setNaming(false)}><X size={15}/></button></form> : <button className="text-button" disabled={!draft} onClick={() => setNaming(true)}><Save size={15}/>保存排版模板</button>}</div>
        <div className="footer-actions"><button className="button secondary" disabled={!draft || saving} onClick={() => void finish()}>完成</button><button className="button primary" disabled={!draft || saving || !canConvert} onClick={() => void finish(true)}>{saving ? <LoaderCircle className="spin" size={16}/> : mode === 'full' ? <Sparkles size={16}/> : <ArrowDownToLine size={16}/>}转换壁纸</button></div></footer>
    </Glass>
  </div>;
}
