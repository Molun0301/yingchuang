// 编辑器里的完整画面：渲染页放在独立来源的 iframe 中，主界面只通过消息控制它。
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { ChildMessage, LiveInfo, LiveLoad, ParentMessage } from './live/protocol';

export type LiveStageHandle = { audio(left: number[], right: number[]): void; parallax(x: number, y: number): void };
/** minute：预览一天中的这一分钟，null 为当前时间 */
type Props = { renderer: string; load: LiveLoad | null; playing: boolean; minute?: number | null; onReady: (info: LiveInfo | null, ms: number) => void; onError: (message: string) => void; onDiagnostic?: (message: string) => void };

export const LiveStage = forwardRef<LiveStageHandle, Props>(function LiveStage({ renderer, load, playing, minute = null, onReady, onError, onDiagnostic }, ref) {
  const frame = useRef<HTMLIFrameElement>(null);
  const booted = useRef(false), sent = useRef(''), clock = useRef<number | null>(null), callbacks = useRef({ onReady, onError, onDiagnostic });
  const [ready, setReady] = useState(false);
  callbacks.current = { onReady, onError, onDiagnostic };
  const post = (message: ParentMessage) => frame.current?.contentWindow?.postMessage(message, '*');
  // 只有场景结构或图层覆盖变化才重新装配；属性改动走热更新，不重载壁纸。
  const structure = load ? JSON.stringify([load.theme.key, load.patch, load.dpr]) : '';
  const properties = load ? JSON.stringify(load.properties) : '';
  const latest = useRef(load);
  latest.current = load;
  useImperativeHandle(ref, () => ({ audio: (left, right) => post({ type: 'audio', left, right }), parallax: (x, y) => post({ type: 'parallax', x, y }) }), []);
  useEffect(() => {
    const receive = (event: MessageEvent<ChildMessage>) => {
      if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      const message = event.data;
      // 渲染页重启后时钟恢复为真实时间，需要重新告知预览时刻。
      if (message.type === 'booted') { booted.current = true; sent.current = ''; if (clock.current !== null) post({ type: 'clock', minute: clock.current }); send(); }
      if (message.type === 'ready') { setReady(true); callbacks.current.onReady(message.info, message.ms); }
      if (message.type === 'error') callbacks.current.onError(message.message);
      if (message.type === 'diagnostic') callbacks.current.onDiagnostic?.(message.message);
    };
    addEventListener('message', receive);
    return () => removeEventListener('message', receive);
  }, []);
  function send() {
    const value = latest.current;
    if (!booted.current || !value) return;
    const key = JSON.stringify([value.theme.key, value.patch, value.dpr]);
    if (key === sent.current) return;
    sent.current = key;
    setReady(false);
    post({ type: 'load', ...value });
  }
  useEffect(() => { if (!load) return; const timer = setTimeout(send, sent.current ? 220 : 0); return () => clearTimeout(timer); }, [structure]);
  useEffect(() => { if (!load || !booted.current || !sent.current) return; const timer = setTimeout(() => post({ type: 'properties', properties: load.properties }), 90); return () => clearTimeout(timer); }, [properties]);
  useEffect(() => { if (booted.current) post({ type: 'playing', playing }); }, [playing]);
  useEffect(() => { if (minute === clock.current) return; clock.current = minute; if (booted.current) post({ type: 'clock', minute }); }, [minute]);
  return <div className={`live-frame ${ready ? 'ready' : ''}`} data-live-frame="">
    <iframe ref={frame} src={renderer} title="壁纸实时渲染" tabIndex={-1} sandbox="allow-scripts allow-same-origin" allow="autoplay"/>
  </div>;
});
