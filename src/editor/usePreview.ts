// 编辑器预览编排：场景壁纸由实时渲染页出画面，转换核心只生成组件字形；视频等非场景壁纸用转换核心的分层预览。
import { useEffect, useRef, useState } from 'react';
import type { Preview, Project, Theme, ThemeDetail } from '../types';
import type { LiveInfo, LivePatch } from '../live/protocol';
import { model } from './model';

export const cleanError = (message: string) => message.replace(/^Error invoking remote method '[^']+': Error: /, '');

type Options = { theme: Theme; data: ThemeDetail | null; project: Project | null; deviceId: string; liveView: boolean; native: boolean };

export function usePreview({ theme, data, project, deviceId, liveView, native }: Options) {
  const [preview, setPreview] = useState<Preview | null>(null), [patch, setPatch] = useState<LivePatch | null>(null);
  const [busy, setBusy] = useState(true), [phase, setPhase] = useState('读取壁纸'), [enhancing, setEnhancing] = useState(false), [error, setError] = useState('');
  const [liveReady, setLiveReady] = useState(false), [liveInfo, setLiveInfo] = useState<LiveInfo | null>(null), [diagnostics, setDiagnostics] = useState<string[]>([]);
  const alive = useRef(true), latest = useRef(project), request = useRef(0), complete = useRef(false), shownRoot = useRef<string | undefined>(undefined);
  const clock = useRef({ running: false, pending: false });
  latest.current = project;
  useEffect(() => {
    alive.current = true;
    const progress = window.yingchuang.onPreviewProgress(event => { if (event.id === theme.id && alive.current) setPhase(event.phase); });
    const ready = window.yingchuang.onPreviewReady(event => {
      if (event.id !== theme.id || event.requestId !== request.current || !alive.current) return;
      setEnhancing(false);
      if (event.error) { setError(cleanError(event.error)); return; }
      if (event.data) { complete.current = true; setPreview(old => ({ ...event.data!, clock: old?.clock ?? event.data!.clock, clockRoot: old?.clockRoot || event.data!.clockRoot })); }
    });
    return () => { alive.current = false; progress(); ready(); void window.yingchuang.cancelPreview(); };
  }, [theme.id]);
  useEffect(() => { shownRoot.current = preview?.assetRoot; }, [preview?.assetRoot]);

  // 非场景壁纸：转换核心生成与导出一致的分层预览，先给快速静态画面，再补齐动效。
  const graphicsKey = project ? JSON.stringify([project.properties, project.layers, project.showWidgets, project.motion.fps, project.export.timeVariation]) : '';
  useEffect(() => {
    if (!project || !data || liveView) return;
    if (!native) { setBusy(false); setError(data.detail.reason || '这类壁纸暂时无法转换。'); return; }
    const serial = ++request.current; setError('');
    const keep = complete.current;
    if (keep) { setEnhancing(true); setBusy(false); } else { setBusy(true); setPhase('生成预览'); }
    const timer = setTimeout(() => {
      void window.yingchuang.preview(theme.id, latest.current!, serial).then(result => {
        if (!alive.current || serial !== request.current) return;
        if (keep && result.progressive) void window.yingchuang.previewMotion(theme.id, serial);
        else {
          complete.current = !result.progressive;
          if (result.progressive && result.assetRoot === shownRoot.current) void window.yingchuang.previewMotion(theme.id, serial);
          setPreview(old => ({ ...result, clock: old?.clock ?? result.clock, clockRoot: old?.clockRoot || result.clockRoot })); setEnhancing(Boolean(result.progressive));
        }
        setError(result.clockError ? cleanError(result.clockError) : '');
      }).catch(failure => { if (alive.current && serial === request.current) { setBusy(false); if (!failure.message.includes('已取消')) setError(cleanError(failure.message)); } });
    }, preview && preview.layers.length ? 600 : 0);
    return () => clearTimeout(timer);
  }, [graphicsKey, Boolean(data), liveView, native]);

  // 场景壁纸：画面来自实时渲染页，预览数据只承载组件字形。
  useEffect(() => {
    complete.current = false;
    if (!data || !liveView) return;
    ++request.current; void window.yingchuang.cancelPreview();
    setEnhancing(false); setBusy(theme.type !== 'application'); setError(''); setPhase('载入画面'); setDiagnostics([]);
    setPreview(old => ({ width: data.live.sceneSize[0], height: data.live.sceneSize[1], title: theme.title, layers: [], restored: [], notes: [], assetRoot: 'live:' + theme.id,
      clockRoot: old?.clockRoot || '', clock: old?.clock || null, config: old?.config || {} }));
  }, [liveView, Boolean(data)]);

  // 图层调整变化时重新生成实时渲染页的场景覆盖。
  const layersKey = project ? JSON.stringify(project.layers) : '';
  useEffect(() => {
    if (!project || !liveView) return;
    const timer = setTimeout(() => void window.yingchuang.livePatch(theme.id, latest.current!).then(value => { if (alive.current) setPatch(value); })
      .catch(failure => setError(cleanError(failure.message))), patch ? 260 : 0);
    return () => clearTimeout(timer);
  }, [layersKey, liveView]);

  // 组件字形：空闲时立即请求，请求中再有变化就在这一份回来后补发最新的，拖动字号时跟手；生成一次约 70 毫秒。
  const glyphKey = project ? model.glyphSignature(project) + deviceId + liveView : '';
  useEffect(() => {
    if (!project || !preview) return;
    if (clock.current.running) { clock.current.pending = true; return; }
    clock.current.running = true;
    void (async () => {
      try {
        do {
          clock.current.pending = false;
          const result = await window.yingchuang.clock(theme.id, latest.current!);
          if (!alive.current) return;
          setPreview(old => old ? { ...old, ...result } : old);
          if (liveView) setError('');
        } while (clock.current.pending);
      } catch (failure) { if (alive.current) setError(cleanError((failure as Error).message)); }
      finally { clock.current.running = false; }
    })();
  }, [glyphKey, Boolean(preview)]);

  const notes = liveView ? diagnostics : preview?.notes || [];
  return { preview, patch, busy, setBusy, phase, enhancing, error, setError, liveReady, setLiveReady, liveInfo, setLiveInfo, notes,
    addDiagnostic: (message: string) => setDiagnostics(old => old.includes(message) || old.length > 30 ? old : [...old, message]),
    requestMotion: () => { if (preview?.progressive) void window.yingchuang.previewMotion(theme.id, request.current); } };
}
