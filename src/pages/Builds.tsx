// 成品：进行中的转换与每张壁纸在当前各机型上的最近一次导出。
import { useState } from 'react';
import { ArrowDownToLine, FolderOpen, LoaderCircle, CircleX, Clock3, X, Trash2, ListChecks, Play, Clock, Layers, Clapperboard, Film } from 'lucide-react';
import type { AppState, Build, BuildReport, QueueItem } from '../types';
import { Glass } from '../appearance';
import { EmptyArt } from './Library';
import type { ToastKind } from '../ui';

const modeNames = { layers: '图层模式', record: '录制模式', video: '视频' } as const;
const modeIcons = { layers: Layers, record: Clapperboard, video: Film } as const;
const qualityNames = { compact: '省空间', standard: '标准', high: '高清' } as const;
const when = (time: number) => new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const megabytes = (size: number) => `${(size / 1048576).toFixed(1)} MB`;

type Props = { state: AppState; onState: (value: Partial<AppState>) => void; notify: (message: string, kind?: ToastKind) => void; onBrowse: () => void };

export function BuildsPage({ state, onState, notify, onBrowse }: Props) {
  const [report, setReport] = useState<{ build: Build; data: BuildReport } | null>(null), [replay, setReplay] = useState<{ build: Build; url: string } | null>(null);
  const tasks = state.queue.filter(item => item.status !== 'done');
  const builds = [...state.builds].sort((a, b) => b.createdAt - a.createdAt);
  const deviceName = (id: string) => state.devices.find(d => d.id === id)?.name || id;
  const cover = (build: Build) => build.preview || state.themes.find(t => t.id === build.themeId)?.preview || '';
  async function openReport(build: Build) { try { setReport({ build, data: await window.yingchuang.buildReport(build.id) }); } catch (e) { notify((e as Error).message, 'error'); } }
  async function openReplay(build: Build) { try { setReplay({ build, url: await window.yingchuang.buildPreview(build.id) }); } catch (e) { notify((e as Error).message, 'error'); } }
  async function remove(build: Build) { onState({ builds: await window.yingchuang.removeBuild(build.id) }); notify('已删除成品记录，.mrc 文件仍在导出目录', 'info'); }
  const task = (item: QueueItem) => { const theme = state.themes.find(t => t.id === item.themeId); return <Glass as="section" refraction={false} className={`queue-item ${item.status}`} key={item.id}>
    <div className="queue-cover">{theme && <img src={theme.preview} alt=""/>}</div>
    <div className="queue-info"><h3>{item.title}</h3><p><span>{deviceName(item.deviceId)}</span>{item.mode && <span className="queue-mode">{modeNames[item.mode]}</span>}</p>
      {item.status === 'running' && <div className="queue-progress"><span style={{ width: `${Math.max(3, item.progress)}%` }}/></div>}{item.status === 'error' && <p className="queue-error">{item.error}</p>}</div>
    <div className="queue-status">{item.status === 'running' ? <><LoaderCircle size={13} className="spin"/>{item.phase} · {Math.round(item.progress)}%</> : item.status === 'error' ? <><CircleX size={14}/>未完成</> : item.status === 'waiting' ? <><Clock3 size={13}/>等待</> : <>已取消</>}</div>
    <div className="queue-action">{['waiting', 'running'].includes(item.status) && <button className="icon-button" aria-label={`取消 ${item.title}`} onClick={() => void window.yingchuang.cancelQueue(item.id)}><X size={17}/></button>}</div>
  </Glass>; };
  return <div className="content-scroll">
    {tasks.length > 0 && <section className="builds-section"><div className="queue-toolbar"><span>{tasks.some(i => ['running', 'waiting'].includes(i.status)) ? '正在转换' : '未完成'}</span>
      <div>{tasks.some(i => ['running', 'waiting'].includes(i.status)) && <button className="text-button" onClick={() => void window.yingchuang.cancelQueue()}>全部取消</button>}
        {tasks.some(i => ['error', 'cancelled'].includes(i.status)) && <button className="text-button" onClick={async () => onState({ queue: await window.yingchuang.clearQueue() })}>清除未完成记录</button>}</div></div>
      <div className="queue-list">{tasks.map(task)}</div></section>}
    {builds.length ? <div className="build-grid">{builds.map((build, index) => { const Icon = modeIcons[build.mode]; return <Glass as="section" refraction={false} className={`build-card ${build.fileExists ? '' : 'missing'}`} key={build.id} style={{ '--i': index } as React.CSSProperties}>
      <div className="build-cover">{cover(build) && <img src={cover(build)} alt=""/>}{build.folderAvailable && <button className="build-play" aria-label={`回放 ${build.title}`} title="回放成品" onClick={() => void openReplay(build)}><Play size={18} fill="currentColor"/></button>}</div>
      <div className="build-info"><h3 title={build.title}>{build.title}</h3>
        <p><span>{deviceName(build.deviceId)}</span><span><Icon size={11}/>{modeNames[build.mode]}</span>{build.timeVariation && <span><Clock size={11}/>随时间变化</span>}</p>
        <p><span>{qualityNames[build.quality]} · {megabytes(build.size)}</span><span>{when(build.createdAt)}</span>{!build.fileExists && <span className="build-missing">文件已移走</span>}</p></div>
      <div className="build-actions">
        <button className="icon-button" aria-label={`在文件夹中显示 ${build.title}`} title="在文件夹中显示" disabled={!build.fileExists} onClick={() => void window.yingchuang.showBuild(build.id)}><FolderOpen size={16}/></button>
        <button className="icon-button" aria-label={`还原差异 ${build.title}`} title={build.notes ? `还原差异（${build.notes} 条）` : '还原差异'} disabled={!build.folderAvailable} onClick={() => void openReport(build)}><ListChecks size={16}/>{build.notes > 0 && <small>{build.notes}</small>}</button>
        <button className="icon-button" aria-label={`删除记录 ${build.title}`} title="删除记录" onClick={() => void remove(build)}><Trash2 size={16}/></button>
      </div>
    </Glass>; })}</div>
      : !tasks.length && <div className="empty-state"><EmptyArt icon={<ArrowDownToLine size={30} strokeWidth={1.5}/>}/><h2>还没有成品</h2><p>转换后的背屏包会出现在这里</p><button className="button secondary" onClick={onBrowse}>浏览壁纸</button></div>}
    {report && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setReport(null); }}><Glass as="section" className="report-dialog" role="dialog" aria-modal="true" aria-label="还原差异">
      <header><div><h2>{report.build.title}</h2><p>{deviceName(report.build.deviceId)} · {report.data.layers} 个图层</p></div><button className="icon-button" aria-label="关闭" onClick={() => setReport(null)}><X size={18}/></button></header>
      <div className="report-body">{report.data.restored.length > 0 && <><h3>已还原</h3><div className="report-tags">{report.data.restored.map(item => <span key={item}>{item}</span>)}</div></>}
        <h3>与电脑上的差异</h3>{report.data.notes.length ? <ul>{report.data.notes.map((note, i) => <li key={i}>{note}</li>)}</ul> : <p className="report-empty">没有差异</p>}</div>
    </Glass></div>}
    {replay && <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) setReplay(null); }}><Glass as="section" className="replay-dialog" role="dialog" aria-modal="true" aria-label="回放成品">
      <header><div><h2>{replay.build.title}</h2><p>{deviceName(replay.build.deviceId)} · 成品回放</p></div><button className="icon-button" aria-label="关闭" onClick={() => setReplay(null)}><X size={18}/></button></header>
      <iframe src={replay.url + '?embed=1'} title="成品回放" sandbox="allow-scripts"/>
    </Glass></div>}
  </div>;
}
