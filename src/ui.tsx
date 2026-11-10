// 通用界面组件：滑动指示的分段控件、侧栏指示条、环境背景。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Layers, Film, Globe, AppWindow, Image as ImageIcon } from 'lucide-react';
import { Glass } from './appearance';

export type ToastKind = 'success' | 'error' | 'info';
export const typeNames: Record<string, string> = { scene: '场景', video: '视频', web: '网页', image: '图片', application: '应用' };
const typeIcons: Record<string, typeof Layers> = { scene: Layers, video: Film, web: Globe, image: ImageIcon, application: AppWindow };
export function TypeIcon({ type, size = 12 }: { type: string; size?: number }) { const Icon = typeIcons[type] || Layers; return <Icon size={size} strokeWidth={2}/>; }
export function Logo() { return <span className="brand-mark" aria-hidden="true"><span/><span/><i/></span>; }

type SegmentOption<T extends string> = { value: T; label: ReactNode; icon?: ReactNode; count?: number; title?: string };

/** 指示块根据选中项实际位置滑动，文字长度不同也能对齐 */
export function Segmented<T extends string>({ value, options, onChange, label, className = '', glass = true }:
  { value: T; options: SegmentOption<T>[]; onChange: (value: T) => void; label: string; className?: string; glass?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ x: number; w: number } | null>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const measure = () => {
      const active = host.querySelector<HTMLElement>('[aria-selected="true"]');
      setBox(active ? { x: active.offsetLeft, w: active.offsetWidth } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [value, options.length]);
  const body = <>
    {box && <span className="segment-indicator" style={{ transform: `translateX(${box.x}px)`, width: box.w }}/>}
    {options.map(option => <button key={option.value} type="button" role="tab" aria-selected={option.value === value} title={option.title}
      className={option.value === value ? 'active' : ''} onClick={() => onChange(option.value)}>
      {option.icon}{option.label && <span>{option.label}</span>}{option.count !== undefined && <small>{option.count}</small>}
    </button>)}
  </>;
  return glass
    ? <Glass className={`segmented-control ${className}`} role="tablist" aria-label={label}><div ref={ref} className="segment-track">{body}</div></Glass>
    : <div className={`segmented-control flat ${className}`} role="tablist" aria-label={label}><div ref={ref} className="segment-track">{body}</div></div>;
}

/** 竖向导航的选中指示条 */
export function useNavIndicator(active: string) {
  const ref = useRef<HTMLElement>(null);
  const [box, setBox] = useState<{ y: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    const measure = () => {
      const item = host.querySelector<HTMLElement>(`[data-nav="${active}"]`);
      setBox(item ? { y: item.offsetTop, h: item.offsetHeight } : null);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [active]);
  return { ref, indicator: box ? <span className="nav-indicator" style={{ transform: `translateY(${box.y}px)`, height: box.h }}/> : null };
}

/**
 * 以当前壁纸封面作为模糊环境光，给玻璃提供可折射的内容；新图加载完成后才淡入。
 * 只取封面第一帧的缩略图：很多封面是动图，直接作背景会让整片界面底色不停变化。
 */
export function Ambient({ image, enabled }: { image: string; enabled: boolean }) {
  const [layers, setLayers] = useState<{ src: string; key: number; image: string }[]>([]);
  const serial = useRef(0);
  useEffect(() => {
    if (!enabled || !image) return;
    const key = ++serial.current, probe = new Image();
    probe.crossOrigin = 'anonymous';
    probe.onload = () => {
      if (key !== serial.current) return;
      const canvas = document.createElement('canvas'), ratio = 96 / Math.max(probe.naturalWidth, probe.naturalHeight, 1);
      canvas.width = Math.max(1, Math.round(probe.naturalWidth * ratio)); canvas.height = Math.max(1, Math.round(probe.naturalHeight * ratio));
      canvas.getContext('2d')!.drawImage(probe, 0, 0, canvas.width, canvas.height);
      const still = canvas.toDataURL('image/png');
      setLayers(old => [...old.filter(layer => layer.image !== image).slice(-1), { src: still, key, image }]);
    };
    probe.src = image;
  }, [image, enabled]);
  return <div className={`ambient ${enabled ? '' : 'off'}`} aria-hidden="true">
    {enabled && layers.map(layer => <div key={layer.key} className="ambient-layer" style={{ backgroundImage: `url("${layer.src}")` }}/>)}
    <div className="ambient-wash"/>
    <div className="ambient-grain"/>
  </div>;
}

/** 图片加载完成后淡入，加载期间显示流光骨架 */
export function FadeImage({ src, alt, className = '' }: { src: string; alt: string; className?: string }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => setLoaded(false), [src]);
  return <img className={`fade-image ${loaded ? 'loaded' : ''} ${className}`} src={src} alt={alt} loading="lazy" draggable="false"
    onLoad={() => setLoaded(true)} onError={() => setLoaded(true)}/>;
}
