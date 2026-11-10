// 应用外观：材质（磨砂 / 液态）、配色（跟随系统 / 浅色 / 深色）与液态玻璃的折射滤镜。
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
  return scheme;
}

// ---------- 液态玻璃折射 ----------
// 每种尺寸生成一张位移贴图：边缘一圈按圆角矩形的法线方向偏移背景，模拟玻璃厚边的透镜折射。
// 滤镜节点必须先于样式引用存在：Chromium 不会为 backdrop-filter 重新解析后插入的 url() 引用。
const filters = new Map<string, string>();
const SVG = 'http://www.w3.org/2000/svg';
let defs: SVGSVGElement | null = null;

function displacementMap(width: number, height: number, radius: number, bezel: number) {
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
        // 越靠近边缘折射越强，按二次曲线衰减，接近玻璃凸边的视觉。
        strength = (1 - inside / bezel) ** 2;
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

function ensureFilter(width: number, height: number, radius: number) {
  // 尺寸按 8 像素取整复用，拖动窗口时不会生成大量滤镜。
  const w = Math.max(16, Math.ceil(width / 8) * 8), h = Math.max(16, Math.ceil(height / 8) * 8);
  const key = `${w}x${h}r${Math.round(radius)}`, id = 'liquid-' + key;
  if (filters.has(key)) return id;
  if (!defs) { defs = element('svg', { width: 0, height: 0, 'aria-hidden': 'true', class: 'glass-filters' }); document.body.prepend(defs); }
  // 位移变化平缓，大面板用低分辨率贴图拉伸即可，减少生成耗时。
  const step = Math.max(1, Math.ceil(Math.max(w, h) / 360));
  const bezel = Math.max(8, Math.min(28, Math.min(w, h) * 0.22));
  const href = displacementMap(Math.ceil(w / step), Math.ceil(h / step), radius / step, bezel / step);
  const filter = element('filter', { id, x: 0, y: 0, width: '100%', height: '100%', 'color-interpolation-filters': 'sRGB' });
  filter.append(
    element('feImage', { href, x: 0, y: 0, width: w, height: h, preserveAspectRatio: 'none', result: 'map' }),
    element('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: 0.8, result: 'soft' }),
    element('feDisplacementMap', { in: 'soft', in2: 'map', scale: Math.max(14, Math.min(46, Math.min(w, h) * 0.35)), xChannelSelector: 'R', yChannelSelector: 'G', result: 'bent' }),
    element('feColorMatrix', { in: 'bent', type: 'saturate', values: 1.35 }));
  defs.append(filter);
  filters.set(key, href);
  if (filters.size > 48) { const oldest = filters.keys().next().value!; filters.delete(oldest); defs.querySelector('#liquid-' + oldest)?.remove(); }
  return id;
}

/**
 * 给玻璃元素挂上材质：液态时按元素尺寸接入折射滤镜；磨砂时交给样式表的模糊。
 * 圆角取元素自身计算值，保证折射边与可见边一致。
 */
export function useGlass<T extends HTMLElement>(ref: RefObject<T | null>, enabled = true) {
  const { material } = useAppearance();
  const [size, setSize] = useState<[number, number, number] | null>(null);
  useEffect(() => {
    const element = ref.current;
    // 嵌套在另一块玻璃里的元素只能看到父面板内部（浏览器的背景根规则），不再叠加折射。
    const host = element?.closest<HTMLElement>('.glass');
    if (!element || !host || !enabled || material !== 'liquid' || host.parentElement?.closest('.glass')) { setSize(null); return; }
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
    const id = ensureFilter(size[0], size[1], size[2]);
    element.style.setProperty('backdrop-filter', `url(#${id}) blur(var(--glass-thickness, 3px)) var(--liquid-tone)`);
  }, [size]);
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
