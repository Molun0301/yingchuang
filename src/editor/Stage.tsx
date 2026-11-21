// 编辑器左侧：模式与时段开关、手机画面（实时渲染层 + 画布）、工具条、提示。
import { useEffect, useRef, useState } from 'react';
import { Pause, Play, Move, MousePointer2, ScanEye, Clock3, RotateCcw, Music, Layers, Clapperboard, LoaderCircle, TriangleAlert, MonitorSmartphone, Info } from 'lucide-react';
import type { Device, Project, SourceLayer, Theme, ThemeDetail, WidgetKey } from '../types';
import { LiveStage, type LiveStageHandle } from '../LiveStage';
import { PreviewCanvas } from '../PreviewCanvas';
import { Glass } from '../appearance';
import { Segmented } from '../ui';
import type { usePreview } from './usePreview';

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

const clockText = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

type Props = {
  theme: Theme; data: ThemeDetail | null; project: Project | null; device: Device; loadError: string;
  mode: 'full' | 'native'; switchable: boolean; liveView: boolean; onMode: (mode: 'layers' | 'record') => void;
  timeVariation: boolean; onTimeVariation: (on: boolean) => void;
  /** 图层页固定了显示的时段图层：会挡住按时间切换的画面 */
  pinned?: { count: number; property: string; onRelease: () => void };
  preview: ReturnType<typeof usePreview>;
  playing: boolean; onPlaying: (playing: boolean) => void; tilt: boolean; onTilt: (tilt: boolean) => void; mask: boolean; onMask: (mask: boolean) => void;
  minute: number | null; onMinute: (minute: number | null) => void;
  selection: WidgetKey[]; onSelect: (keys: WidgetKey[]) => void; onUpdate: (change: (project: Project) => void, key: string) => void;
  layers?: { items: SourceLayer[]; selected: string; onPick: (id: string) => void };
  onFontWarning: (key: WidgetKey) => void;
};

export function Stage(props: Props) {
  const { theme, data, project, device, mode, liveView, preview } = props;
  const live = useRef<LiveStageHandle>(null), screen = useRef<HTMLDivElement>(null), notesButton = useRef<HTMLButtonElement>(null);
  const [dpr, setDpr] = useState(0), [canvasReady, setCanvasReady] = useState(false), [loadMs, setLoadMs] = useState(0);
  const [audioUrl, setAudioUrl] = useState(''), [notesOpen, setNotesOpen] = useState(false);
  const application = theme.type === 'application';
  // 渲染分辨率与目标机型像素对齐，打开时计算一次；之后窗口缩放不再改倍率，避免实时画面整体重载。
  useEffect(() => {
    const node = screen.current;
    if (!node || dpr) return;
    const observer = new ResizeObserver(() => { if (node.clientWidth) setDpr(Math.min(2.5, Math.max(1, Math.round(device.width / node.clientWidth * 4) / 4))); });
    observer.observe(node); return () => observer.disconnect();
  }, [Boolean(project), dpr]);
  useAudioPreview(mode === 'full' ? audioUrl : '', props.playing, (left, right) => live.current?.audio(left, right));
  useEffect(() => {
    if (!notesOpen) return;
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setNotesOpen(false); } };
    const close = (event: PointerEvent) => { if (!(event.target as Element)?.closest?.('.notes-anchor')) setNotesOpen(false); };
    document.addEventListener('keydown', escape, true); document.addEventListener('pointerdown', close);
    return () => { document.removeEventListener('keydown', escape, true); document.removeEventListener('pointerdown', close); };
  }, [notesOpen]);
  const timed = mode === 'native' && props.timeVariation;
  const now = new Date(), nowMinute = Math.floor((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
  const ready = liveView ? preview.liveReady || application : canvasReady;
  const warnings = preview.preview?.clock?.warnings || [];
  const noteCount = preview.notes.length + warnings.length;
  const error = props.loadError || preview.error;
  const badge = theme.type === 'video' ? '视频' : mode === 'full' ? '录制模式' : '图层模式';
  return <>
    <div className="preview-heading">
      <div className="heading-modes">
        {props.switchable ? <Segmented label="转换方式" value={mode} onChange={value => props.onMode(value === 'full' ? 'record' : 'layers')} options={[{ value: 'native', label: '图层模式', icon: <Layers size={13}/>, title: '逐层导出，背屏上每层独立感应视差' }, { value: 'full', label: '录制模式', icon: <Clapperboard size={13}/>, title: '录制完整画面为循环视频，整幅随感应平移' }]}/>
          : <span className="type-chip">{theme.type === 'video' ? <><Clapperboard size={11}/>视频</> : mode === 'full' ? <><Clapperboard size={11}/>录制模式</> : <><Layers size={11}/>图层模式</>}</span>}
        {theme.type === 'scene' && mode === 'native' && <Glass className="segmented-control time-toggle" title="背屏按系统时间切换昼夜画面；导出时间和包体会增加">
          <div className="segment-track">
            {props.timeVariation && <span className="segment-indicator" style={{ width: '100%' }}/>}
            <button type="button" role="switch" aria-checked={props.timeVariation} aria-label="随时间变化（实验）" className={props.timeVariation ? 'active' : ''} onClick={() => props.onTimeVariation(!props.timeVariation)}><Clock3 size={13}/><span>随时间变化</span><small>实验</small></button>
          </div>
        </Glass>}
      </div>
      <div className="device-chip" title="机型在设置中更换"><MonitorSmartphone size={14}/><span>{device.name}</span><small>{device.width} × {device.height}</small></div>
    </div>
    <div className="preview-stage"><div className="device-frame" style={{ '--screen-ratio': device.width / device.height } as React.CSSProperties}>
      <div className="screen" ref={screen} style={{ borderRadius: `${device.cornerRadius / device.width * 100}% / ${device.cornerRadius / device.height * 100}%` }}>
        <div className={`screen-poster ${ready ? 'hidden' : ''}`} style={{ backgroundImage: `url("${theme.preview}")` }}/>
        {liveView && data && project && !application && <LiveStage ref={live} renderer={data.live.renderer} playing={props.playing} minute={timed ? props.minute : null}
          load={preview.patch && dpr ? { theme: data.live.theme, properties: project.properties, patch: preview.patch, playing: props.playing, dpr } : null}
          onReady={(info, ms) => { preview.setLiveReady(true); preview.setLiveInfo(info); preview.setBusy(false); setLoadMs(ms); }} onError={message => { preview.setBusy(false); preview.setError(message); }}
          onDiagnostic={preview.addDiagnostic}/>}
        {mode === 'full' && application && <div className="live-frame live-poster" data-live-frame="" style={{ backgroundImage: `url("${theme.preview}")` }}/>}
        {project && <PreviewCanvas preview={preview.preview} project={project} device={device} poster="" playing={props.playing} tilt={props.tilt} mask={props.mask}
          selection={props.selection} onSelect={props.onSelect} onUpdate={props.onUpdate} minute={props.minute} layers={props.layers}
          live={liveView ? { ready: preview.liveReady || application, layered: mode === 'native', motion: preview.liveInfo?.maxMotion ?? 1, parallax: (x, y) => live.current?.parallax(x, y) } : undefined}
          onError={message => { preview.setBusy(false); preview.setError(message); }}
          onReady={() => { setCanvasReady(true); preview.setBusy(false); preview.requestMotion(); }}/>}
        {!error && (preview.busy || preview.enhancing) && <div className="preview-status"><LoaderCircle size={13} className="spin"/>{preview.busy ? preview.phase : '正在更新预览'}</div>}
        <div className="preview-badge" data-load-ms={loadMs || undefined}>{badge} · {device.width}×{device.height}</div>
      </div>
    </div></div>
    <Glass className="preview-tools"><div>
      <button className={`icon-button ${!props.playing ? 'active' : ''}`} aria-label={props.playing ? '暂停动效' : '播放动效'} title="播放 / 暂停（空格）" onClick={() => props.onPlaying(!props.playing)}>{props.playing ? <Pause size={17}/> : <Play size={17}/>}</button>
      <span className="tool-divider"/>
      <button className={`tool-button ${!props.tilt ? 'active' : ''}`} title="拖动画面取景、拖动组件排版，滚轮缩放" onClick={() => props.onTilt(false)}><Move size={15}/><span>移动</span></button>
      <button className={`tool-button ${props.tilt ? 'active' : ''}`} title="移动鼠标模拟倾斜手机" onClick={() => props.onTilt(true)}><MousePointer2 size={15}/><span>倾斜预览</span></button>
      <button className={`tool-button ${props.mask ? 'active' : ''}`} title="显示镜头遮挡的位置" onClick={() => props.onMask(!props.mask)}><ScanEye size={15}/><span>镜头遮挡</span></button>
      {timed && <><span className="tool-divider"/><label className="time-scrub" title="预览一天中不同时刻的画面"><Clock3 size={15}/><input type="range" aria-label="预览时刻" min={0} max={1425} step={15} value={props.minute ?? nowMinute} onChange={e => props.onMinute(Number(e.target.value))}/><span>{clockText(props.minute ?? nowMinute)}</span>{props.minute !== null && <button className="icon-button" aria-label="回到当前时间" title="回到当前时间" onClick={() => props.onMinute(null)}><RotateCcw size={12}/></button>}</label></>}
      {mode === 'full' && <button className={`tool-button ${audioUrl ? 'active' : ''}`} title="选择本地音乐，预览壁纸的音频响应" onClick={async () => { if (audioUrl) { setAudioUrl(''); return; } const file = await window.yingchuang.chooseFile('audio-preview'); if (file) setAudioUrl(file); }}><Music size={15}/><span>{audioUrl ? '停止试听' : '试听音乐'}</span></button>}
    </div><span className="tool-divider"/><span className="zoom-readout" title="滚轮缩放取景">{project ? Math.round(project.framing.scale * 100) : 100}%</span></Glass>
    <div className="stage-notes">
      {error ? <div className="editor-error" role="status" title={error}><TriangleAlert size={15}/><span>{error}</span></div>
        : timed && props.pinned ? <div className="stage-warning" role="status"><TriangleAlert size={14}/>
          <span>图层页固定了 {props.pinned.count} 个时段图层的显示，{props.pinned.property ? `“${props.pinned.property}”` : '壁纸'}没法按时间切换画面</span>
          <button className="stage-warning-action" onClick={props.pinned.onRelease}>恢复由壁纸控制</button></div>
        : noteCount > 0 && <div className="notes-anchor">
          <button ref={notesButton} className="text-button" aria-expanded={notesOpen} onClick={() => setNotesOpen(!notesOpen)}><Info size={13}/>提示<small>{noteCount}</small></button>
          {notesOpen && <Glass className="notes-popover" refraction={false}><ul>{preview.notes.map((note, i) => <li key={i}>{note}</li>)}
            {warnings.map((warning, i) => <li key={`${warning.key}-${i}`}>{warning.message} <button className="text-button" onClick={() => { setNotesOpen(false); props.onFontWarning(warning.key); }}>更换字体</button></li>)}</ul></Glass>}
        </div>}
    </div>
  </>;
}
