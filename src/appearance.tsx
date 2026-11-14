// 应用外观：材质（磨砂 / 液态）、配色（跟随系统 / 浅色 / 深色）与玻璃边缘的折射滤镜。
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { HTMLAttributes, ReactNode, RefObject } from 'react';

export type Material = 'frosted' | 'liquid';
export type Scheme = 'system' | 'light' | 'dark';
export type Appearance = { material: Material; scheme: Scheme; ambient: boolean; density: 'comfortable' | 'compact' };
export const defaultAppearance: Appearance = { material: 'liquid', scheme: 'system', ambient: true, density: 'comfortable' };

export const AppearanceContext = createContext<Appearance>(defaultAppearance);
export const useAppearance = () => useContext(AppearanceContext);

const darkQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;
export function useResolvedScheme(scheme: Scheme): 'light' | 'dark' {
  const systemDark = useSyncExternalStore(callback => { darkQuery?.addEventListener('change', callback); return () => darkQuery?.removeEventListener('change', callback); },
    () => Boolean(darkQuery?.matches));
  return scheme === 'system' ? (systemDark ? 'dark' : 'light') : scheme;
}

/** 根元素上的数据属性驱动整套样式变量；切换时短暂开启全局过渡，平时不给每个元素挂过渡。 */
export function useApplyAppearance(appearance: Appearance) {
  const scheme = useResolvedScheme(appearance.scheme);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const changed = root.dataset.material !== appearance.material || root.dataset.scheme !== scheme;
    if (changed && root.dataset.material) {
      root.classList.add('appearance-changing');
      window.setTimeout(() => root.classList.remove('appearance-changing'), 420);
    }
    root.dataset.material = appearance.material;
    root.dataset.scheme = scheme;
    root.dataset.density = appearance.density;
  }, [appearance.material, scheme, appearance.density]);
  // 液态玻璃的边缘高光跟随指针：只给指针所在的那块玻璃写入相对坐标，其余元素不用重算样式。
  useEffect(() => {
    if (appearance.material !== 'liquid') return;
    let current: HTMLElement | null = null, frame = 0, x = 0, y = 0;
    const clear = () => { current?.style.removeProperty('--pointer-x'); current?.style.removeProperty('--pointer-y'); current = null; };
    const paint = () => {
      frame = 0;
      if (!current) return;
      const box = current.getBoundingClientRect();
      current.style.setProperty('--pointer-x', `${Math.round(x - box.left)}px`);
      current.style.setProperty('--pointer-y', `${Math.round(y - box.top)}px`);
    };
    const move = (event: PointerEvent) => {
      const glass = (event.target as Element | null)?.closest?.<HTMLElement>('.glass') ?? null;
      if (glass !== current) { clear(); current = glass; }
      x = event.clientX; y = event.clientY;
      if (current && !frame) frame = requestAnimationFrame(paint);
    };
    document.addEventListener('pointermove', move, { passive: true });
    const root = document.documentElement;
    root.addEventListener('pointerleave', clear);
    return () => { document.removeEventListener('pointermove', move); root.removeEventListener('pointerleave', clear); cancelAnimationFrame(frame); clear(); };
  }, [appearance.material]);
  return scheme;
}

// ---------- 玻璃边缘折射 ----------
// 每种尺寸生成一张位移贴图：边缘一圈按圆角矩形的法线方向偏移背景，模拟玻璃厚边的透镜折射。
// 滤镜节点必须先于样式引用存在：Chromium 不会为 backdrop-filter 重新解析后插入的 url() 引用。
const filters = new Map<string, string>();
const SVG = 'http://www.w3.org/2000/svg';
let defs: SVGSVGElement | null = null;

/**
 * 液态玻璃的边缘是一圈圆弧凸面 h(x) = √(1 − (1 − x)²)（x 为从外缘到折射带内侧的位置），
 * 光线垂直射入、按折射率 1.5 偏折，位移量 = 曲面高度 × tan(入射角 − 折射角)，归一化到 0～1。
 * 圆弧比超椭圆衰减慢，整条折射带都能看到背景被弯折、向边缘拉伸。
 */
const lensProfile = (() => {
  const height = (x: number) => Math.sqrt(1 - (1 - x) ** 2);
  const values = Array.from({ length: 129 }, (_, i) => {
    const x = Math.min(.999, Math.max(.001, i / 128)), slope = (height(Math.min(1, x + .001)) - height(x - .001)) / .002;
    const incidence = Math.atan(slope), refracted = Math.asin(Math.sin(incidence) / 1.5);
    return height(x) * Math.tan(incidence - refracted);
  });
  const peak = Math.max(...values);
  return values.map(value => value / peak);
})();
const lensStrength = (t: number) => lensProfile[Math.min(128, Math.round(t * 128))];
// 磨砂沿用原先的二次衰减：越靠近边缘越强。
const softStrength = (t: number) => (1 - t) ** 2;

function displacementMap(width: number, height: number, radius: number, bezel: number, profile: (t: number) => number) {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!;
  const image = context.createImageData(width, height), data = image.data;
  const r = Math.min(radius, width / 2, height / 2);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5 - width / 2, py = y + 0.5 - height / 2;
      const qx = Math.abs(px) - (width / 2 - r), qy = Math.abs(py) - (height / 2 - r);
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
      const inside = -(Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r);
      let nx = 0, ny = 0, strength = 0;
      if (inside >= 0 && inside < bezel) {
        strength = profile(inside / bezel);
        if (ox > 0 || oy > 0) { const length = Math.hypot(ox, oy) || 1; nx = ox / length * Math.sign(px); ny = oy / length * Math.sign(py); }
        else if (qx > qy) nx = Math.sign(px); else ny = Math.sign(py);
      }
      const index = (y * width + x) * 4;
      data[index] = 128 - nx * strength * 127;
      data[index + 1] = 128 - ny * strength * 127;
      data[index + 2] = 128; data[index + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

function element<K extends keyof SVGElementTagNameMap>(tag: K, attributes: Record<string, string | number>) {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

// 只保留一个颜色通道的矩阵，用于色散时分别偏折红、绿、蓝。
const channel = (index: number) => [0, 1, 2, 3].map(row => [0, 1, 2, 3, 4].map(column => row === column && (row === index || row === 3) ? 1 : 0).join(' ')).join(' ');

function ensureFilter(width: number, height: number, radius: number, material: Material) {
  // 尺寸按 8 像素取整复用，拖动窗口时不会生成大量滤镜。
  const w = Math.max(16, Math.ceil(width / 8) * 8), h = Math.max(16, Math.ceil(height / 8) * 8), short = Math.min(w, h);
  const key = `${material}-${w}x${h}r${Math.round(radius)}`, id = 'glass-' + key;
  if (filters.has(key)) return id;
  if (!defs) { defs = element('svg', { width: 0, height: 0, 'aria-hidden': 'true', class: 'glass-filters' }); document.body.prepend(defs); }
  const liquid = material === 'liquid';
  // 液态的折射带更宽、偏移更大；磨砂保持原来的轻微折射。
  // 液态的折射带约占短边三成；最大偏移约为折射带宽度的 0.65 倍（位移贴图满值对应 scale 的一半）。
  const bezel = liquid ? Math.max(10, Math.min(40, short * .3)) : Math.max(8, Math.min(28, short * .22));
  const scale = liquid ? bezel * 1.3 : Math.max(14, Math.min(46, short * .35));
  // 位移变化平缓，大面板用低分辨率贴图拉伸即可，减少生成耗时。
  const step = Math.max(1, Math.ceil(Math.max(w, h) / 360));
  const href = displacementMap(Math.ceil(w / step), Math.ceil(h / step), radius / step, bezel / step, liquid ? lensStrength : softStrength);
  const filter = element('filter', { id, x: 0, y: 0, width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' });
  filter.append(
    element('feImage', { href, x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none', result: 'map' }),
    element('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: liquid ? 0 : .8, result: 'soft' }));
  if (liquid) {
    // 色散：红、绿、蓝按不同偏移量折射后再相加，折射带里出现彩边。
    [1, .92, .84].forEach((ratio, index) => filter.append(
      element('feDisplacementMap', { in: 'soft', in2: 'map', scale: scale * ratio, xChannelSelector: 'R', yChannelSelector: 'G', result: `bent${index}` }),
      element('feColorMatrix', { in: `bent${index}`, type: 'matrix', values: channel(index), result: `only${index}` })));
    filter.append(
      element('feComposite', { in: 'only0', in2: 'only1', operator: 'arithmetic', k2: 1, k3: 1, result: 'rg' }),
      element('feComposite', { in: 'rg', in2: 'only2', operator: 'arithmetic', k2: 1, k3: 1, result: 'bent' }),
      element('feColorMatrix', { in: 'bent', type: 'saturate', values: 1.1 }));
  } else filter.append(
    element('feDisplacementMap', { in: 'soft', in2: 'map', scale, xChannelSelector: 'R', yChannelSelector: 'G', result: 'bent' }),
    element('feColorMatrix', { in: 'bent', type: 'saturate', values: 1.35 }));
  defs.append(filter);
  filters.set(key, href);
  if (filters.size > 48) { const oldest = filters.keys().next().value!; filters.delete(oldest); defs.querySelector('#glass-' + oldest)?.remove(); }
  return id;
}

/**
 * 给玻璃元素挂上材质：按元素尺寸接入当前材质的折射滤镜，模糊量由样式变量 --glass-thickness × --glass-clarity 决定。
 * 圆角取元素自身计算值，保证折射边与可见边一致。
 */
export function useGlass<T extends HTMLElement>(ref: RefObject<T | null>, enabled = true) {
  const { material } = useAppearance();
  const [size, setSize] = useState<[number, number, number] | null>(null);
  useEffect(() => {
    const element = ref.current;
    // 磨砂的嵌套玻璃只用浅填充；液态的嵌套玻璃（编辑器里的工具条、设置里的分段控件）也折射它后面的画面。
    const host = element?.closest<HTMLElement>('.glass');
    if (!element || !host || !enabled || (material !== 'liquid' && host.parentElement?.closest('.glass'))) { setSize(null); return; }
    const measure = () => {
      const radius = parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0;
      setSize(old => old && old[0] === element.offsetWidth && old[1] === element.offsetHeight && old[2] === radius ? old : [element.offsetWidth, element.offsetHeight, radius]);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [material, enabled]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!size || size[0] < 4 || size[1] < 4) { element.style.removeProperty('backdrop-filter'); return; }
    const id = ensureFilter(size[0], size[1], size[2], material);
    element.style.setProperty('backdrop-filter', `url(#${id}) blur(calc(var(--glass-thickness, 3px) * var(--glass-clarity, 1))) var(--liquid-tone)`);
  }, [size, material]);
}

type GlassProps = HTMLAttributes<HTMLElement> & { as?: 'div' | 'aside' | 'section' | 'header' | 'nav' | 'footer'; refraction?: boolean; children?: ReactNode };
/**
 * 带材质的容器：底色与背景滤镜放在独立的背景层上，内容层在其上方。
 * 直接在含 iframe、画布的大面板上挂折射滤镜时，Chromium 会把滤镜结果画到子内容之上。
 */
export function Glass({ as: Tag = 'div', className = '', refraction = true, children, ...props }: GlassProps) {
  const layer = useRef<HTMLSpanElement>(null);
  useGlass(layer, refraction);
  return <Tag className={`glass ${className}`} {...props}><span ref={layer} className="glass-backdrop" aria-hidden="true"/>{children}</Tag>;
}
