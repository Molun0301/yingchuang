import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownToLine, ArrowUpRight, Check, CircleAlert, FolderOpen, LoaderCircle, RefreshCw, Sparkles, X } from 'lucide-react';
import { Glass } from './appearance';
import { Toggle } from './controls';
import type { ToastKind } from './ui';
import type { UpdateDownload, UpdateProgress, UpdateRelease, UpdateSettings, UpdateStatus } from './types';
import './updater.css';

const errorText = (error: unknown) => (error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, '');
const bytes = (value: number) => value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${(value / 1024).toFixed(0)} KB`;

export function useUpdater(notify: (message: string, kind?: ToastKind) => void) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [release, setRelease] = useState<UpdateRelease | null>(null);
  const [open, setOpen] = useState(false), [checking, setChecking] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'downloading' | 'ready' | 'installing'>('idle');
  const [progress, setProgress] = useState<UpdateProgress | null>(null);
  const [downloaded, setDownloaded] = useState<UpdateDownload | null>(null);
  const [error, setError] = useState(''), [checked, setChecked] = useState(false);
  useEffect(() => {
    void window.yingchuang.updateSettings().then(setStatus).catch(e => setError(errorText(e)));
    return window.yingchuang.onUpdate(event => {
      if (event.type === 'available') { setRelease(event.release); setOpen(true); }
      if (event.type === 'progress') setProgress(event.progress);
      if (event.type === 'downloaded') { setDownloaded(event.download); setPhase('ready'); }
      if (event.type === 'cancelled') { setPhase('idle'); setProgress(null); }
      if (event.type === 'error') setError(event.message);
    });
  }, []);
  async function check() {
    setChecking(true); setError('');
    try {
      const next = await window.yingchuang.updateCheck();
      setRelease(next); setChecked(true);
      if (next.available) setOpen(true);
    } catch (e) { setError(errorText(e)); }
    finally { setChecking(false); }
  }
  async function settings(patch: Partial<Pick<UpdateSettings, 'auto' | 'skipVersion'>>) {
    setStatus(old => old ? { ...old, settings: { ...old.settings, ...patch } } : old);
    try { setStatus(await window.yingchuang.updateSettings(patch)); }
    catch (e) { setError(errorText(e)); }
  }
  async function skip() {
    try {
      setStatus(await window.yingchuang.updateSettings({ skipVersion: release!.latest }));
      setOpen(false);
    } catch (e) { setError(errorText(e)); }
  }
  async function download() {
    setError(''); setProgress(null); setDownloaded(null); setPhase('downloading');
    try { await window.yingchuang.updateDownload(); }
    catch (e) { setError(errorText(e)); setPhase('idle'); }
  }
  async function cancel() {
    try { await window.yingchuang.updateCancel(); }
    catch (e) { setError(errorText(e)); }
  }
  async function install() {
    setError(''); setPhase('installing');
    try {
      const result = await window.yingchuang.updateInstall();
      if (result.manual) { setPhase('ready'); setOpen(false); notify(result.message!, 'info'); }
    } catch (e) { setError(errorText(e)); setPhase('ready'); }
  }
  async function openRelease() {
    try { await window.yingchuang.openRelease(release?.url); }
    catch (e) { setError(errorText(e)); }
  }
  return { status, release, open, setOpen, checking, phase, progress, downloaded, error, checked,
    check, settings, skip, download, cancel, install, openRelease };
}

type Updater = ReturnType<typeof useUpdater>;

export function UpdateBadge({ updater }: { updater: Updater }) {
  if (!updater.release?.available || updater.status?.settings.skipVersion === updater.release.latest) return null;
  return <button className="update-badge" onClick={() => updater.setOpen(true)} title={`发现新版本 ${updater.release.latest}`}><i/>新版本</button>;
}

// 更新说明只渲染文字结构，不执行正文中的 HTML 或外部链接。
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).map((part, i) => {
    if (part.startsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = /^\[([^\]]+)\]\([^)]+\)$/.exec(part);
    return link ? <span key={i} className="update-link-text">{link[1]}</span> : part;
  });
}
function ReleaseNotes({ text }: { text: string }) {
  const elements: ReactNode[] = [], lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const heading = /^#{1,6}\s+(.+)$/.exec(line);
    if (heading) { elements.push(<h3 key={i}>{inline(heading[1])}</h3>); continue; }
    const item = /^\s*(?:[-*+]\s+|\d+\.\s+)(.+)$/.exec(line);
    if (item) {
      const start = i, ordered = /^\s*\d+\./.test(line), items = [item[1]];
      while (i + 1 < lines.length) {
        const next = /^\s*(?:[-*+]\s+|\d+\.\s+)(.+)$/.exec(lines[i + 1]);
        if (!next || /^\s*\d+\./.test(lines[i + 1]) !== ordered) break;
        items.push(next[1]); i++;
      }
      const content = items.map((value, j) => <li key={j}>{inline(value)}</li>);
      elements.push(ordered ? <ol key={start}>{content}</ol> : <ul key={start}>{content}</ul>);
    } else elements.push(<p key={i}>{inline(line)}</p>);
  }
  return <div className="update-notes">{elements.length ? elements : <p>此版本未提供更新说明。</p>}</div>;
}

export function UpdateDialog({ updater: u }: { updater: Updater }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!u.open) return;
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, [u.open]);
  if (!u.open) return null;
  const release = u.release!, busy = u.phase === 'downloading' || u.phase === 'installing';
  const ready = u.downloaded?.version === release.latest;
  const published = new Date(release.publishedAt).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
  return <dialog ref={dialog} className="updater-overlay" aria-labelledby="update-title" onCancel={event => { event.preventDefault(); u.setOpen(false); }}>
    <Glass className="updater-dialog">
      <header className="update-header"><div className="update-emblem"><Sparkles size={23}/></div><div><h2 id="update-title">发现新版本 {release.latest}</h2><p>当前版本 {release.current} · 发布于 {published}</p></div><button className="icon-button" aria-label="关闭更新对话框" onClick={() => u.setOpen(false)}><X size={18}/></button></header>
      <div className="update-body"><ReleaseNotes text={release.notes}/><button className="text-button update-release-link" onClick={() => void u.openRelease()}>查看完整发布说明<ArrowUpRight size={14}/></button></div>
      <footer className="update-footer">
        {u.error && <p className="update-error" role="alert"><CircleAlert size={15}/>{u.error}</p>}
        {!release.asset && <p className="update-hint">此版本没有适用于当前系统的下载文件，可前往发布页查看。</p>}
        {u.phase === 'downloading' && <div className="update-transfer" role="status"><div className="update-transfer-heading"><span>{u.progress ? `正在下载 · ${Math.min(100, u.progress.percent).toFixed(0)}%` : '正在连接下载…'}</span><span>{u.progress ? `${bytes(u.progress.speed)}/秒` : ''}</span></div><div className="update-progress" role="progressbar" aria-label="更新下载进度" aria-valuenow={Math.round(u.progress?.percent || 0)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${Math.min(100, u.progress?.percent || 0)}%` }}/></div><p>{bytes(u.progress?.downloaded || 0)} / {bytes(release.asset?.size || 0)}</p></div>}
        {ready && <p className="update-verified"><Check size={15}/>下载完成，文件完整性校验通过</p>}
        <div className="update-actions"><div>{!busy && <button className="text-button" onClick={() => void u.skip()}>跳过此版本</button>}</div><div><button className="button secondary" onClick={() => u.setOpen(false)}>稍后</button>{u.phase === 'downloading' ? <button className="button secondary" onClick={() => void u.cancel()}><X size={15}/>取消</button> : ready ? <button className="button primary" disabled={u.phase === 'installing'} onClick={() => void u.install()}>{u.phase === 'installing' ? <LoaderCircle size={16} className="spin"/> : u.downloaded?.canInstall ? <RefreshCw size={16}/> : <FolderOpen size={16}/>}{u.phase === 'installing' ? '正在准备安装…' : u.downloaded?.canInstall ? '重启并安装' : '打开下载位置'}</button> : <button className="button primary" disabled={!release.asset} onClick={() => void u.download()}><ArrowDownToLine size={16}/>{u.error ? '重新下载' : '下载并更新'}</button>}</div></div>
        {release.asset && !busy && !ready && <p className="update-size">下载大小 {bytes(release.asset.size)}</p>}
      </footer>
    </Glass>
  </dialog>;
}

export function UpdateSettingsSection({ updater: u, version }: { updater: Updater; version: string }) {
  const busy = u.checking || u.phase === 'downloading' || u.phase === 'installing';
  return <Glass as="section" refraction={false} className="settings-section update-settings"><h2>关于与更新</h2>
    <div className="settings-row"><div><h3>映窗 {u.status?.current || version}</h3><p>莫伦Molun</p></div><button className="button secondary" disabled={busy} onClick={() => void u.check()}>{u.checking ? <LoaderCircle className="spin" size={15}/> : <RefreshCw size={15}/>}{u.checking ? '检查中…' : '检查更新'}</button></div>
    {u.error ? <p className="update-error" role="alert"><CircleAlert size={14}/>{u.error}</p> : u.release?.available ? <div className="update-check-result"><Sparkles size={14}/><span>发现新版本 {u.release.latest}</span><button className="text-button" onClick={() => u.setOpen(true)}>查看更新<ArrowUpRight size={13}/></button></div> : u.checked && <p className="update-check-result"><Check size={14}/>已是最新版本</p>}
    <div className="settings-row"><div><h3>自动检查更新</h3><p>启动后检查新版本，每 6 小时最多检查一次</p></div><Toggle label="自动检查更新" hideLabel checked={u.status?.settings.auto ?? true} onChange={auto => void u.settings({ auto })}/></div>
    <div className="settings-row"><div><h3>版本发布</h3></div><button className="text-button" onClick={() => void u.openRelease()}>查看发布页<ArrowUpRight size={14}/></button></div>
  </Glass>;
}
