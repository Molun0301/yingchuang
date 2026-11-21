// 独立来源的壁纸渲染页：预览时嵌在编辑器的 iframe 中，录制时由隐藏窗口加载。
// 壁纸脚本在这里执行，本页不持有任何文件或系统接口。
import { mount, editorOf, type AudioSource, type SceneInstance, type Source } from '@webwallgl/editor';
import type { ChildMessage, LiveLoad, LivePatch, LiveTheme, LutResult, ObserveLayer, ObserveRequest, ObserveSnapshot, ParentMessage, RecordJob } from './protocol';
import { frameScene } from './framing';

type RecorderBridge = {
  job(): Promise<RecordJob>;
  frame(data: Uint8Array): Promise<void>;
  ready(): Promise<void>;
  fail(message: string): Promise<void>;
  layer(meta: { id: number; width: number; height: number; count: number; bbox: number[]; still?: boolean }): Promise<void>;
  next(snapshot: ObserveSnapshot | null): Promise<ObserveRequest | null>;
  done(result?: Record<number, LutResult>): Promise<void>;
};
declare global { interface Window { recorder?: RecorderBridge } }

const stage = document.getElementById('stage') as HTMLDivElement;
const recording = new URLSearchParams(location.search).get('mode') === 'record';
const packages = new Map<string, Promise<Map<string, Uint8Array> | null>>();
let instance: SceneInstance | null = null;
let loadSerial = 0;
const bands = { left: new Float32Array(64), right: new Float32Array(64) };
let lastRead = 0;
const audio: AudioSource = { snapshot: () => bands };

function post(message: ChildMessage) { if (!recording) parent.postMessage(message, '*'); }

/** 按 PKGV 索引切出各资源，不复制数据 */
function readPackage(buffer: ArrayBuffer) {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer), decoder = new TextDecoder();
  let position = 0;
  const u32 = () => { const value = view.getUint32(position, true); position += 4; return value; };
  const text = () => { const length = u32(); const value = decoder.decode(bytes.subarray(position, position + length)); position += length; return value; };
  if (!text().startsWith('PKGV')) throw new Error('不是壁纸引擎资源包');
  const entries: [string, number, number][] = [];
  for (let count = u32(); count > 0; count--) entries.push([text(), u32(), u32()]);
  const files = new Map<string, Uint8Array>();
  for (const [name, offset, size] of entries) files.set(normal(name), bytes.subarray(position + offset, position + offset + size));
  return files;
}
const ENGINE_FALLBACK = /^(effects|materials\/effects|shaders\/effects)\//;
const normal = (name: string) => name.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').toLowerCase();
const encodePath = (name: string) => name.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').split('/').map(encodeURIComponent).join('/');

async function fetchBytes(url: string, signal?: AbortSignal) {
  try { const response = await fetch(url, { signal }); return response.ok ? new Uint8Array(await response.arrayBuffer()) : null; }
  catch (error) { if ((error as Error).name === 'AbortError') throw error; return null; }
}
function packageOf(theme: LiveTheme) {
  if (!theme.pkg) return Promise.resolve(null);
  if (!packages.has(theme.key)) {
    packages.set(theme.key, fetch(theme.base + 'scene.pkg').then(async response => {
      if (!response.ok) throw new Error('无法读取 scene.pkg');
      return readPackage(await response.arrayBuffer());
    }));
    // 只保留最近两个主题的资源包，切换主题时释放内存。
    while (packages.size > 2) packages.delete(packages.keys().next().value!);
  }
  return packages.get(theme.key)!;
}

const numbers = (raw: unknown, fallback: number[]) => {
  const value = raw && typeof raw === 'object' && 'value' in (raw as object) ? (raw as { value: unknown }).value : raw;
  const parts = String(value ?? '').trim().split(/\s+/).map(Number);
  return fallback.map((item, index) => Number.isFinite(parts[index]) ? parts[index] : item);
};

// 逐层烘焙时的场景底色占位值：清屏遇到它就改为全透明，其余清屏（效果缓冲）不受影响。
const SENTINEL = [0.123, 0.456, 0.789];
/** 让渲染器的画布带透明通道，并把场景底色清成透明；必须在创建 WebGL 上下文之前调用 */
/**
 * 逐层渲染的底色。图片、文字等图层每帧先黑底、再白底各渲染一次，两张结果之差就是这一层的透明度，
 * 与渲染器内部如何合成（叠底、泛光、整块拷贝）无关。粒子每次渲染都会随机生成，两次对不上，
 * 改用透明底单次渲染：粒子直接画在最终画面上，透明底即可读出其透明度。
 */
const matte: { clear: 'black' | 'white' | 'transparent' } = { clear: 'black' };

/** 接管画布透明通道、场景底色与画到最终画面上的加法混合；必须在创建 WebGL 上下文之前调用 */
function matteBackground() {
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, options?: { alpha?: boolean }) {
    const context = getContext.call(this, type as 'webgl2', type === 'webgl2' ? { ...options, alpha: true, desynchronized: true, powerPreference: 'high-performance' } : options);
    if (type === 'webgl2' && context) trackBakeGL(context as WebGL2RenderingContext);
    return context;
  } as typeof getContext;
  const proto = WebGL2RenderingContext.prototype;
  let bound: WebGLFramebuffer | null = null, finalTarget: WebGLFramebuffer | null | undefined;
  const bindFramebuffer = proto.bindFramebuffer;
  proto.bindFramebuffer = function (this: WebGL2RenderingContext, target: number, framebuffer: WebGLFramebuffer | null) {
    if (target === this.FRAMEBUFFER || target === this.DRAW_FRAMEBUFFER) bound = framebuffer;
    return bindFramebuffer.call(this, target, framebuffer);
  };
  // 透明底时，画到最终画面上的加法绘制只累加颜色、不累加透明度，读出时按亮度折算透明度。
  const transparentAdd = () => matte.clear === 'transparent' && bound === finalTarget;
  const blendFuncSeparate = proto.blendFuncSeparate;
  proto.blendFuncSeparate = function (this: WebGL2RenderingContext, srcRGB: number, dstRGB: number, srcAlpha: number, dstAlpha: number) {
    const additive = transparentAdd() && dstRGB === this.ONE && srcAlpha === this.ONE && dstAlpha === this.ONE;
    return blendFuncSeparate.call(this, srcRGB, dstRGB, additive ? this.ZERO : srcAlpha, dstAlpha);
  };
  const blendFunc = proto.blendFunc;
  proto.blendFunc = function (this: WebGL2RenderingContext, source: number, destination: number) {
    if (transparentAdd() && destination === this.ONE) return blendFuncSeparate.call(this, source, this.ONE, this.ZERO, this.ONE);
    return blendFunc.call(this, source, destination);
  };
  const clearColor = proto.clearColor;
  proto.clearColor = function (this: WebGL2RenderingContext, r: number, g: number, b: number, a: number) {
    const sentinel = Math.abs(r - SENTINEL[0]) < 1e-3 && Math.abs(g - SENTINEL[1]) < 1e-3 && Math.abs(b - SENTINEL[2]) < 1e-3;
    if (!sentinel) return clearColor.call(this, r, g, b, a);
    finalTarget = bound;
    if (matte.clear === 'transparent') return clearColor.call(this, 0, 0, 0, 0);
    const v = matte.clear === 'white' ? 1 : 0;
    return clearColor.call(this, v, v, v, 1);
  };
}

type LutTile = { id: number; index: number; x: number; y: number; color: [number, number, number] };
type LutGrid = { size: number; targets: number[]; tiles: LutTile[]; primary: LutTile[]; checks: LutTile[][] };

/** 在调色层之前铺满标准色块；四角与中心各留五块重复颜色。 */
function insertLutGrid(scene: { objects: { id: unknown }[] }, target: number, width: number, height: number, grid: LutGrid) {
  const { size } = grid, count = size ** 3;
  const columns = Math.ceil(Math.sqrt((count + 25) * width / height)), rows = Math.ceil((count + 25) / columns);
  const middle = Math.floor((size - 1) / 2);
  const colors = [0, ((middle * size + middle) * size + middle), count - 1, (size - 1) * size * size + middle, (middle * size + size - 1) * size];
  const starts = [0, columns - 5, Math.floor(rows / 2) * columns + Math.floor((columns - 5) / 2), (rows - 1) * columns, rows * columns - 5];
  const reserved = new Map(starts.flatMap(start => colors.map((index, i) => [start + i, index] as const)));
  grid.checks = colors.map(() => []);
  let next = 0, id = Math.max(...scene.objects.map(object => Number(object.id))) + 1;
  const objects = [];
  for (let slot = 0; slot < rows * columns; slot++) {
    const repeated = reserved.get(slot), primary = repeated === undefined && next < count;
    const index = primary ? next++ : repeated ?? 0;
    const color: [number, number, number] = [index % size, Math.floor(index / size) % size, Math.floor(index / size ** 2)].map(value => value / (size - 1)) as [number, number, number];
    const x = (slot % columns + 0.5) / columns, y = (Math.floor(slot / columns) + 0.5) / rows;
    const tile = { id: id++, index, x, y, color };
    grid.tiles.push(tile);
    if (primary) grid.primary[index] = tile;
    if (repeated !== undefined) grid.checks[colors.indexOf(repeated)].push(tile);
    objects.push({ id: tile.id, image: 'models/util/solidlayer.json', size: `${width / columns} ${height / rows}`,
      scale: '1 1 1', origin: `${x * width} ${(1 - y) * height} 0`, color: color.join(' '), alpha: 1, visible: true });
  }
  scene.objects.splice(scene.objects.findIndex(object => Number(object.id) === target), 0, ...objects);
}

/** 与 Python 导出的 loaded_scene 相同的覆盖规则 */
function patchScene(text: string, patch: LivePatch, lut?: LutGrid) {
  const scene = JSON.parse(text.replace(/^\uFEFF/, ''));
  liveObjects = scene.objects || [];
  if (patch.transparent) { scene.general ??= {}; scene.general.clearcolor = SENTINEL.join(' '); scene.general.clearenabled = true; }
  if (patch.keep) {
    // 保留目标、上级，以及效果里引用其画面（_rt_imageLayerComposite_<编号>）的图层；被引用的图层即使隐藏也会渲染到合成纹理。
    type SceneObject = { id: unknown; parent?: unknown; effects?: unknown };
    const byId = new Map<string, SceneObject>((scene.objects || []).map((object: SceneObject) => [String(object.id), object]));
    const kept = new Set<string>(), pending = patch.keep.map(String);
    for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
      const object = byId.get(key);
      if (kept.has(key) || !object) continue;
      kept.add(key);
      if (object.parent != null) pending.push(String(object.parent));
      for (const match of JSON.stringify(object.effects ?? []).matchAll(/_rt_imageLayerComposite_(\d+)_/g)) pending.push(match[1]);
    }
    scene.objects = (scene.objects || []).filter((object: SceneObject) => kept.has(String(object.id)));
  }
  const projection = scene.general?.orthogonalprojection;
  const width = Number(projection?.width) || 1920, height = Number(projection?.height) || 1080;
  const hidden = new Set(patch.hidden.map(String));
  for (const object of scene.objects || []) {
    const id = String(object.id);
    const state = patch.state?.[id];
    if (state) {
      for (const field of ['visible', 'alpha', 'color', 'origin', 'scale', 'angles', 'brightness'] as const) if (field in state) object[field] = state[field];
      if ('text' in state) object.text = { value: state.text };
    }
    if (hidden.has(id)) object.visible = false;
    const edit = patch.layers[id];
    if (!edit) continue;
    for (const field of ['visible', 'alpha', 'color'] as const) if (field in edit) object[field] = edit[field];
    if ('text' in edit) object.text = { value: String(edit.text ?? '') };
    if ('fontsize' in edit) { object.pointsize = Number(edit.fontsize); if ('fontsize' in object) object.fontsize = Number(edit.fontsize); }
    if (typeof edit.font === 'string' && edit.font) object.font = edit.font.startsWith('theme:') ? edit.font.slice(6) : edit.font;
    if ('x' in edit || 'y' in edit) {
      const origin = numbers(object.origin, [width / 2, height / 2, 0]);
      if ('x' in edit) origin[0] = Number(edit.x) * width;
      if ('y' in edit) origin[1] = (1 - Number(edit.y)) * height;
      object.origin = origin.join(' ');
    }
    if ('rotation' in edit) object.angles = `0 0 ${-Number(edit.rotation) * Math.PI / 180}`;
    if ('scale' in edit) object.scale = numbers(object.scale, [1, 1, 1]).map(value => value * Number(edit.scale)).join(' ');
  }
  if (lut) {
    // 测量时用普通可见值替换脚本绑定，防止隐藏后又被下一帧脚本显示。
    for (const object of scene.objects) if (lut.targets.includes(Number(object.id))) object.visible = true;
    insertLutGrid(scene, lut.targets[0], width, height, lut);
  }
  return new TextEncoder().encode(JSON.stringify(scene));
}

function sourceFor({ theme, patch }: LiveLoad, lut?: LutGrid): Source {
  const project = theme.project as { file?: string; type?: string;
    general?: { properties?: Record<string, { type?: string; options?: { label: string; value: string | number }[] }> } };
  const entry = /\.json$/i.test(theme.file) ? theme.file : 'scene.json';
  return {
    key: theme.key + ':' + JSON.stringify(patch) + (lut ? ':lut:' + lut.size : ''),
    project: async () => {
      const result = structuredClone({ ...project, type: theme.type });
      // 补入不会被选中的非整数占位值，避免 WebWallGL 将作者定义的整数字符串选项转成数字。
      for (const property of Object.values(result.general?.properties ?? {})) {
        if (property.type === 'combo' && property.options?.length && property.options.every(({ value }) => typeof value === 'string' && /^-?\d+$/.test(value.trim()))) {
          property.options.push({ label: '', value: '__preserve_string__' });
        }
      }
      return result;
    },
    scenePkg: async () => { throw new Error('场景改由目录读取器装配'); },
    sceneDir: async signal => {
      const files = await packageOf(theme);
      const cache = new Map<string, Uint8Array | null>();
      const read = async (name: string, abort?: AbortSignal) => {
        const key = normal(name);
        if (cache.has(key)) return cache.get(key)!;
        lastRead = performance.now();
        let value: Uint8Array | null = null;
        if (patch.fonts[name]) value = await fetchBytes(patch.fonts[name], abort);
        value ??= files?.get(key) ?? null;
        // 资源包主题的全部内容都在包内；散装工程才按目录读取。
        if (!value && !files) value = await fetchBytes(theme.base + encodePath(name), abort);
        // 引擎目录只补散装工程引用的内置特效；公共着色器头与内置粒子贴图由渲染器自带的重建版本处理，官方原文件与其不兼容。
        if (!value && theme.engine && ENGINE_FALLBACK.test(key)) value = await fetchBytes(theme.engine + encodePath(name), abort);
        if (value && key === normal(entry)) value = patchScene(new TextDecoder().decode(value), patch, lut);
        cache.set(key, value);
        return value;
      };
      if (!await read(entry, signal)) return null;
      return { entry, read };
    },
    webEntry: async () => ({ url: theme.base + encodePath(theme.file || 'index.html') }),
    mediaEntry: async () => ({ url: theme.base + encodePath(theme.file), type: theme.type }),
  };
}

/** 去掉本应用内部键和指向本机绝对路径的文件属性，壁纸只接收原作者定义的属性值 */
function wallpaperProperties(values: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(values).filter(([key, value]) =>
    !key.startsWith('__') && ['string', 'number', 'boolean'].includes(typeof value) && !(typeof value === 'string' && /^([a-z]:[\\/]|\/)/i.test(value)))) as Record<string, string | number | boolean>;
}

async function load(input: LiveLoad, lut?: LutGrid) {
  // 壁纸脚本在载入时拿到当时的 Date；先换成可调的模拟时钟（与真实时间一致），之后拖动预览时刻才能影响已载入的脚本。
  if (globalThis.Date === RealDate) fixClock((RealDate.now() - midnight.getTime()) / 60000);
  const serial = ++loadSerial, started = performance.now();
  const options = {
    source: sourceFor(input, lut), fit: 'stretch' as const, renderDpr: input.dpr, properties: wallpaperProperties(input.properties),
    audio, media: null, volume: 0, autoplay: input.playing, autoQuality: false, mountTimeoutMs: 60000,
    // FXAA 后处理会把整幅透明度写成不透明，逐层烘焙时关闭以保留图层透明区域。
    quality: { antiAliasing: input.patch.transparent ? 'off' as const : 'fxaa' as const, particles: 'high' as const, postProcessing: 'high' as const },
    onDiagnostic: (message: string, level: string) => { if (level !== 'info') post({ type: 'diagnostic', level, message }); },
    onError: (error: Error) => post({ type: 'error', message: error.message }),
  };
  instance?.destroy({ releasePkgCache: true });
  instance = null;
  stage.replaceChildren();
  try {
    const created = await mount(stage, options);
    if (serial !== loadSerial) { created.destroy({ releasePkgCache: true }); return null; }
    instance = created;
    parallaxNodes = parallaxPlan(liveObjects); parallaxApplied = '';
    post({ type: 'ready', info: created.info && { ...created.info, maxMotion: Math.max(1, ...parallaxNodes.filter(node => node.drawn).map(node => node.motion)) }, ms: Math.round(performance.now() - started) });
    return created;
  } catch (error) {
    // 场景包读取被有意转给目录读取器；目录里也读不到场景文件时，渲染库会把这个转交原因带出来。
    const message = (error as Error).message.includes('场景改由目录读取器装配') ? '读不到壁纸的场景文件，壁纸可能不完整或已损坏。' : (error as Error).message;
    if (serial === loadSerial) post({ type: 'error', message });
    const attached = (error as { instance?: SceneInstance }).instance;
    attached?.destroy({ releasePkgCache: true });
    throw error;
  }
}

// —— 编辑器图层模式的实时预览：逐层感应与预览时刻 ——
type SceneObject = Record<string, unknown> & { id: number; parent?: number | null };
type ParallaxNode = { id: number; parent: number | null; motion: number; movable: boolean; drawn: boolean };
let liveObjects: SceneObject[] = [], parallaxNodes: ParallaxNode[] = [], parallaxApplied = '';
const parallaxBase = new Map<number, number[]>();

/** 与转换核心一致：景深取自身 parallaxDepth 的 x，未设置时沿用上级；感应倍数 = clamp(1 + 景深 × 0.45, 0.2, 2)。 */
function parallaxPlan(objects: SceneObject[]): ParallaxNode[] {
  parallaxBase.clear();
  const byId = new Map(objects.map(object => [Number(object.id), object])), depths = new Map<number, number>();
  const depthOf = (object: SceneObject): number => {
    const id = Number(object.id);
    if (!depths.has(id)) {
      const parent = object.parent != null ? byId.get(Number(object.parent)) : undefined;
      depths.set(id, numbers(object.parallaxDepth, [parent ? depthOf(parent) : 0, 0])[0]);
    }
    return depths.get(id)!;
  };
  const bound = (value: unknown) => Boolean(value && typeof value === 'object' && ('script' in value || 'animation' in value));
  return objects.map(object => ({ id: Number(object.id), parent: object.parent != null ? Number(object.parent) : null,
    motion: Math.min(2, Math.max(0.2, 1 + depthOf(object) * 0.45)), movable: !bound(object.origin),
    drawn: 'image' in object || 'particle' in object || 'text' in object }));
}

/** 按手机图层模式移动各层：每层的世界位移 = 倾斜量 × 自身倍数；子层只补与上级已移动量的差值，脚本或时间轴控制位置的层保持不动。 */
async function applyParallax(x: number, y: number) {
  const control = instance && editorOf(instance);
  const key = x.toFixed(2) + ',' + y.toFixed(2);
  if (!control || key === parallaxApplied) return;
  parallaxApplied = key;
  const byId = new Map(parallaxNodes.map(node => [node.id, node])), moved = new Map<number, number>();
  const world = (id: number | null): number => {
    if (id === null || !byId.has(id)) return 0;
    if (!moved.has(id)) { const node = byId.get(id)!; moved.set(id, node.movable ? node.motion : world(node.parent)); }
    return moved.get(id)!;
  };
  const changes: Promise<void>[] = [];
  for (const node of parallaxNodes) {
    if (!node.movable) continue;
    if (!parallaxBase.has(node.id)) { const origin = control.getLayerProps(node.id)?.origin; if (!origin) continue; parallaxBase.set(node.id, [...origin]); }
    const base = parallaxBase.get(node.id)!, local = node.motion - world(node.parent);
    changes.push(control.setLayerProps(node.id, { origin: [base[0] + x * local, base[1] - y * local, base[2]] }));
  }
  await Promise.all(changes);
}

/** 预览时刻：模拟时钟只往前走（回到更早时刻时换成之后某天的同一时刻），避开渲染器按秒、按日缓存的时刻。 */
let previewDay = 0;
function setPreviewClock(minute: number | null) {
  const real = new RealDate(), target = minute ?? real.getHours() * 60 + real.getMinutes() + real.getSeconds() / 60;
  const current = (Date.now() - midnight.getTime()) / 60000;
  // 回到当前时间且时钟未被拨动过时（相差几秒内）留在今天，不换到第二天。
  while (previewDay * 1440 + target < current - .05) previewDay++;
  fixClock(target, previewDay);
}

function receive(event: MessageEvent<ParentMessage>) {
  if (event.source !== parent || !event.data || typeof event.data !== 'object') return;
  const message = event.data;
  if (message.type === 'load') void load(message).catch(() => {});
  if (message.type === 'properties') instance?.setProperties(wallpaperProperties(message.properties));
  if (message.type === 'playing') { if (message.playing) instance?.resume(); else instance?.pause(); }
  if (message.type === 'dpr') instance?.setRenderDpr(message.dpr);
  if (message.type === 'parallax') void applyParallax(message.x, message.y);
  if (message.type === 'clock') setPreviewClock(message.minute);
  if (message.type === 'audio') {
    for (let i = 0; i < 64; i++) { bands.left[i] = Number(message.left[i]) || 0; bands.right[i] = Number(message.right[i]) || 0; }
  }
}

/** 应用窗口：桌面采集实时画面，按窗口实际比例套用取景后逐帧送出 */
async function capture(bridge: RecorderBridge, job: RecordJob) {
  const constraints = { audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: job.sourceId, maxFrameRate: job.fps, maxWidth: 3840, maxHeight: 2160 } } };
  const stream = await navigator.mediaDevices.getUserMedia(constraints as unknown as MediaStreamConstraints);
  const video = document.createElement('video');
  video.srcObject = stream; video.muted = true;
  await video.play();
  await new Promise(resolve => setTimeout(resolve, job.warmup * 1000 / job.fps));
  const output = document.createElement('canvas');
  output.width = job.crop.width; output.height = job.crop.height;
  const context = output.getContext('2d', { willReadFrequently: true })!;
  const width = output.width / (1 + 2 * job.margin!.x), height = output.height / (1 + 2 * job.margin!.y);
  const framing = frameScene(video.videoWidth, video.videoHeight, width, height, job.layout!, job.margin!.x, job.margin!.x ? job.margin!.y / job.margin!.x : 0);
  const sx = (-width * framing.marginX - framing.left) / framing.scale, sy = (-height * framing.marginY - framing.top) / framing.scale;
  const started = performance.now();
  try {
    for (let i = 0; i < job.frames; i++) {
      context.drawImage(video, sx, sy, output.width / framing.scale, output.height / framing.scale, 0, 0, output.width, output.height);
      const pixels = context.getImageData(0, 0, output.width, output.height).data;
      await bridge.frame(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
      // 按开始时刻对齐节拍，单帧处理变慢时不累积误差。
      const wait = started + (i + 1) * 1000 / job.fps - performance.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    }
  } finally { for (const track of stream.getTracks()) track.stop(); }
}

type BakeGLState = {
  read: WebGLFramebuffer | null; draw: WebGLFramebuffer | null; program: WebGLProgram | null; vao: WebGLVertexArrayObject | null;
  active: number; textures: Map<number, WebGLTexture | null>; arrays: Map<number, WebGLTexture | null>; samplers: Map<number, WebGLSampler | null>;
  viewport: number[]; colorMask: boolean[]; enabled: Set<number>; packBuffer: WebGLBuffer | null; pack: Map<number, number>;
};
const bakeGLStates = new WeakMap<WebGL2RenderingContext, BakeGLState>();

/** 从上下文创建起记录实际状态写入，避免隐藏窗口逐帧查询状态时等待图形进程。 */
function trackBakeGL(gl: WebGL2RenderingContext) {
  if (bakeGLStates.has(gl)) return;
  const state: BakeGLState = { read: null, draw: null, program: null, vao: null, active: gl.TEXTURE0,
    textures: new Map(), arrays: new Map(), samplers: new Map(), viewport: [0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight],
    colorMask: [true, true, true, true], enabled: new Set([gl.DITHER]), packBuffer: null,
    pack: new Map([[gl.PACK_ALIGNMENT, 4], [gl.PACK_ROW_LENGTH, 0], [gl.PACK_SKIP_PIXELS, 0], [gl.PACK_SKIP_ROWS, 0]]) };
  bakeGLStates.set(gl, state);
  const bindFramebuffer = gl.bindFramebuffer, useProgram = gl.useProgram, bindVertexArray = gl.bindVertexArray;
  const activeTexture = gl.activeTexture, bindTexture = gl.bindTexture, bindSampler = gl.bindSampler;
  const viewport = gl.viewport, colorMask = gl.colorMask, enable = gl.enable, disable = gl.disable;
  const bindBuffer = gl.bindBuffer, pixelStorei = gl.pixelStorei;
  gl.bindFramebuffer = (target, value) => {
    bindFramebuffer.call(gl, target, value);
    if (target === gl.FRAMEBUFFER || target === gl.READ_FRAMEBUFFER) state.read = value;
    if (target === gl.FRAMEBUFFER || target === gl.DRAW_FRAMEBUFFER) state.draw = value;
  };
  gl.useProgram = value => { useProgram.call(gl, value); state.program = value; };
  gl.bindVertexArray = value => { bindVertexArray.call(gl, value); state.vao = value; };
  gl.activeTexture = value => { activeTexture.call(gl, value); state.active = value; };
  gl.bindTexture = (target, value) => {
    bindTexture.call(gl, target, value);
    if (target === gl.TEXTURE_2D) state.textures.set(state.active, value);
    if (target === gl.TEXTURE_2D_ARRAY) state.arrays.set(state.active, value);
  };
  gl.bindSampler = (unit, value) => { bindSampler.call(gl, unit, value); state.samplers.set(unit, value); };
  gl.viewport = (x, y, w, h) => { viewport.call(gl, x, y, w, h); state.viewport = [x, y, w, h]; };
  gl.colorMask = (r, g, b, a) => { colorMask.call(gl, r, g, b, a); state.colorMask = [r, g, b, a]; };
  gl.enable = name => { enable.call(gl, name); state.enabled.add(name); };
  gl.disable = name => { disable.call(gl, name); state.enabled.delete(name); };
  gl.bindBuffer = (target, value) => { bindBuffer.call(gl, target, value); if (target === gl.PIXEL_PACK_BUFFER) state.packBuffer = value; };
  gl.pixelStorei = (name, value) => { pixelStorei.call(gl, name, value); if (state.pack.has(name)) state.pack.set(name, value as number); };
  // 删除当前绑定的对象会自动解除绑定，记录也随之更新。
  const deleteTexture = gl.deleteTexture, deleteFramebuffer = gl.deleteFramebuffer, deleteVertexArray = gl.deleteVertexArray;
  const deleteSampler = gl.deleteSampler, deleteBuffer = gl.deleteBuffer;
  gl.deleteTexture = value => { deleteTexture.call(gl, value); for (const bindings of [state.textures, state.arrays]) for (const [unit, bound] of bindings) if (bound === value) bindings.set(unit, null); };
  gl.deleteFramebuffer = value => { deleteFramebuffer.call(gl, value); if (state.read === value) state.read = null; if (state.draw === value) state.draw = null; };
  gl.deleteVertexArray = value => { deleteVertexArray.call(gl, value); if (state.vao === value) state.vao = null; };
  gl.deleteSampler = value => { deleteSampler.call(gl, value); for (const [unit, bound] of state.samplers) if (bound === value) state.samplers.set(unit, null); };
  gl.deleteBuffer = value => { deleteBuffer.call(gl, value); if (state.packBuffer === value) state.packBuffer = null; };
}

/** 自有绘制只借用状态，不改渲染器的纹理、缓冲内容或顶点属性。异常时也恢复原绑定。 */
function withBakeGL<T>(gl: WebGL2RenderingContext, state: BakeGLState, draw: () => T): T {
  const { read, draw: framebuffer, program, vao, active, viewport, packBuffer } = state;
  const colorMask = [...state.colorMask], pack = [...state.pack];
  const switches = [gl.BLEND, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.CULL_FACE, gl.STENCIL_TEST, gl.DITHER,
    gl.RASTERIZER_DISCARD, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE].map(name => [name, state.enabled.has(name)] as const);
  const units = [0, 1, 2].map(unit => ({ texture: state.textures.get(gl.TEXTURE0 + unit) ?? null, array: state.arrays.get(gl.TEXTURE0 + unit) ?? null, sampler: state.samplers.get(unit) ?? null }));
  try { return draw(); }
  finally {
    // 读写附件选择属于各自的帧缓冲；自有操作只改自有帧缓冲的附件选择。清屏颜色从未改动。
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer); gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
    gl.useProgram(program); gl.bindVertexArray(vao);
    units.forEach((unit, index) => { gl.activeTexture(gl.TEXTURE0 + index); gl.bindTexture(gl.TEXTURE_2D, unit.texture); gl.bindTexture(gl.TEXTURE_2D_ARRAY, unit.array); gl.bindSampler(index, unit.sampler); });
    gl.activeTexture(active); gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
    gl.colorMask(colorMask[0], colorMask[1], colorMask[2], colorMask[3]);
    for (const [name, enabled] of switches) { if (enabled) gl.enable(name); else gl.disable(name); }
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, packBuffer);
    for (const [name, value] of pack) gl.pixelStorei(name, value);
  }
}

/**
 * 显卡抠图：黑底、白底两次渲染结果复制到两张纹理，着色器求出透明度与非预乘颜色并翻转为自上而下，
 * 每帧只读回一张抠好的画面。（整层帧存在显存里最后一次性读回时，Chromium 隐藏窗口的同步读回会阻塞数十秒，已弃用。）
 */
function bakeMatte(gl: WebGL2RenderingContext, width: number, height: number) {
  const state = bakeGLStates.get(gl)!;
  const textures: WebGLTexture[] = [], framebuffers: WebGLFramebuffer[] = [];
  const resources = withBakeGL(gl, state, () => {
    gl.activeTexture(gl.TEXTURE0);
    const texture = () => {
      const value = gl.createTexture()!; textures.push(value);
      gl.bindTexture(gl.TEXTURE_2D, value);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      return value;
    };
    const target = (item: WebGLTexture) => {
      const value = gl.createFramebuffer()!; framebuffers.push(value); gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, value);
      gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, item, 0);
      return value;
    };
    const program = gl.createProgram()!;
    for (const [type, source] of [[gl.VERTEX_SHADER, `#version 300 es
      void main() {
        vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
        gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
      }`], [gl.FRAGMENT_SHADER, `#version 300 es
      precision highp float;
      precision highp int;
      uniform sampler2D blackImage;
      uniform sampler2D whiteImage;
      uniform bool particle;
      out vec4 color;
      void main() {
        ivec2 p = ivec2(gl_FragCoord.xy);
        p.y = textureSize(blackImage, 0).y - 1 - p.y;
        ivec4 b = ivec4(round(texelFetch(blackImage, p, 0) * 255.0));
        ivec3 delta = ivec3(round(texelFetch(whiteImage, p, 0).rgb * 255.0)) - b.rgb;
        // 普通图层：透明度 = 1 −（白底 − 黑底）；粒子透明底单次渲染，加法发光只累加颜色，取四个通道的最大值。
        int a = particle ? max(max(b.a, b.r), max(b.g, b.b)) : 255 - min(delta.r, min(delta.g, delta.b));
        color = vec4(0.0);
        // 与整数运算一致：颜色截断小数，透明度按字节取低 8 位。
        if (a > 3) color = vec4(vec3(min(ivec3(255), b.rgb * 255 / a)), float(a & 255)) / 255.0;
      }`]] as const) {
      const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader); gl.attachShader(program, shader); gl.deleteShader(shader);
    }
    gl.linkProgram(program);
    const black = texture(), white = texture(), output = texture();
    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, 'blackImage'), 0); gl.uniform1i(gl.getUniformLocation(program, 'whiteImage'), 1);
    return { program, black, white, blackTarget: target(black), whiteTarget: target(white), output: target(output),
      particle: gl.getUniformLocation(program, 'particle'), vao: gl.createVertexArray() };
  });
  return {
    /** 把渲染器刚画好的最终画面复制到黑底或白底纹理 */
    copy: (white = false) => {
      const framebuffer = state.draw, scissor = state.enabled.has(gl.SCISSOR_TEST);
      try {
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, white ? resources.whiteTarget : resources.blackTarget); gl.disable(gl.SCISSOR_TEST);
        gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      } finally { gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, framebuffer); if (scissor) gl.enable(gl.SCISSOR_TEST); }
    },
    /** 抠出一帧并读回：自上而下的非预乘 RGBA，透明处全为 0 */
    frame: (particle: boolean) => withBakeGL(gl, state, () => {
      for (const name of [gl.BLEND, gl.DEPTH_TEST, gl.SCISSOR_TEST, gl.CULL_FACE, gl.STENCIL_TEST, gl.DITHER,
        gl.RASTERIZER_DISCARD, gl.SAMPLE_ALPHA_TO_COVERAGE, gl.SAMPLE_COVERAGE]) gl.disable(name);
      gl.colorMask(true, true, true, true); gl.bindVertexArray(resources.vao);
      for (let i = 0; i < 2; i++) gl.bindSampler(i, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resources.output); gl.viewport(0, 0, width, height); gl.useProgram(resources.program);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, resources.black);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, resources.white);
      gl.uniform1i(resources.particle, particle ? 1 : 0); gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      gl.pixelStorei(gl.PACK_ALIGNMENT, 1); gl.pixelStorei(gl.PACK_ROW_LENGTH, 0); gl.pixelStorei(gl.PACK_SKIP_PIXELS, 0); gl.pixelStorei(gl.PACK_SKIP_ROWS, 0);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, resources.output); gl.readBuffer(gl.COLOR_ATTACHMENT0);
      const data = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return data;
    }),
    destroy: () => {
      for (const framebuffer of framebuffers) gl.deleteFramebuffer(framebuffer);
      for (const texture of textures) gl.deleteTexture(texture);
      gl.deleteProgram(resources.program); gl.deleteVertexArray(resources.vao);
    },
  };
}

/** 两帧之间变化（任一通道相差超过 2）的像素数 */
function changedPixels(a: Uint8Array, b: Uint8Array) {
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i] - b[i]) > 2 || Math.abs(a[i + 1] - b[i + 1]) > 2 || Math.abs(a[i + 2] - b[i + 2]) > 2 || Math.abs(a[i + 3] - b[i + 3]) > 2) changed++;
  }
  return changed;
}

/** 分块累计预乘颜色与透明度；透明边缘的无效颜色不参与周期搜索。 */
function bakeSignature(data: Uint8Array, width: number, height: number) {
  const columns = Math.min(32, width), rows = Math.min(32, height), signature = new Float32Array(columns * rows * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (y * width + x) * 4, target = (Math.floor(y * rows / height) * columns + Math.floor(x * columns / width)) * 4;
    const alpha = data[source + 3] / 255;
    for (let channel = 0; channel < 3; channel++) signature[target + channel] += data[source + channel] * alpha;
    signature[target + 3] += data[source + 3];
  }
  const area = width * height / (columns * rows);
  for (let i = 0; i < signature.length; i++) signature[i] /= area;
  return signature;
}

function bakeDistance(a: Float32Array, b: Float32Array) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return sum / a.length;
}

/** 在采样帧之间搜索小数位移；比较整个观察段，不能只凭首帧相似就认定周期。 */
function bakeCandidates(samples: Float32Array[], fps: number) {
  const minimum = fps * .5, maximum = samples.length - 1 - fps;
  let motion = 0;
  for (let i = 1; i < samples.length; i++) motion += bakeDistance(samples[i - 1], samples[i]);
  motion /= samples.length - 1;
  if (!motion) return [];
  const error = (lag: number) => {
    const whole = Math.floor(lag), fraction = lag - whole, last = samples.length - 2 - Math.ceil(lag);
    let sum = 0, count = 0;
    for (let index = 0; index <= last; index++) {
      const a = samples[index], b = samples[index + whole], c = samples[index + whole + 1];
      for (let k = 0; k < a.length; k++) sum += (a[k] - b[k] - (c[k] - b[k]) * fraction) ** 2;
      count += a.length;
    }
    return sum / count / motion;
  };
  const candidates: { period: number; error: number }[] = [];
  for (let lag = Math.floor(minimum); lag <= Math.ceil(maximum); lag++) {
    const center = Math.max(minimum, Math.min(maximum, lag)), score = error(center);
    if (center > minimum && score > error(Math.max(minimum, center - 1))) continue;
    if (center < maximum && score > error(Math.min(maximum, center + 1))) continue;
    let left = Math.max(minimum, center - 1), right = Math.min(maximum, center + 1);
    for (let i = 0; i < 16; i++) {
      const a = left + (right - left) / 3, b = right - (right - left) / 3;
      if (error(a) < error(b)) right = b; else left = a;
    }
    const refined = (left + right) / 2, best = score < error(refined) ? center : refined, distance = error(best);
    // 相似度必须明显好于相邻帧，排除随机画面和仅仅变化缓慢的长动画。
    if (distance < .6) candidates.push({ period: best / fps, error: distance });
  }
  return candidates.sort((a, b) => a.period - b.period);
}

/** 用真实渲染细化到毫秒，并以完整像素在五个相位复核；按从短到长的顺序选最小周期。 */
async function detectBakePeriod(samples: Float32Array[], fps: number, width: number, height: number,
  frameAt: (seconds: number) => Promise<Uint8Array>, limit: number) {
  const duration = (samples.length - 1) / fps;
  for (const candidate of bakeCandidates(samples, fps)) {
    const offsets = [0, .193, .417, .691, 1].map(part => part * (duration - candidate.period - 1 / fps));
    const reference = [];
    for (const offset of offsets) reference.push(await frameAt(offset));
    let period = candidate.period;
    if (candidate.error > 1e-10) {
      // 选择变化最明显的一小段，用到两端画面的距离差定义相位。连续运动与阶跃换帧都能定位交点，
      // 避免插值误差把半帧周期筛掉，也避免平坦误差区让极值搜索误选二倍周期。
      let index = 0, largest = -1;
      const last = Math.floor((duration - period - 1 / fps) * fps);
      for (let i = 0; i <= last; i++) {
        const distance = bakeDistance(samples[i], samples[i + 1]);
        if (distance > largest) { largest = distance; index = i; }
      }
      const from = index / fps, to = (index + 1) / fps;
      const a = bakeSignature(await frameAt(from), width, height), b = bakeSignature(await frameAt(to), width, height);
      const phase = async (at: number) => {
        const value = bakeSignature(await frameAt(at), width, height);
        return bakeDistance(value, a) - bakeDistance(value, b);
      };
      const crossing = async (left: number, right: number) => {
        for (let i = 0; i < 13; i++) {
          const middle = (left + right) / 2;
          if (await phase(middle) < 0) left = middle; else right = middle;
        }
        return (left + right) / 2;
      };
      const left = from + period - 1 / fps, right = to + period + 1 / fps;
      if (await phase(left) > 0 || await phase(right) < 0) continue;
      period = await crossing(left, right) - await crossing(from, to);
    }
    // 背屏动画使用毫秒时间点；取帧时就采用同一个周期，避免写包时再截断时长。
    period = Math.round(period * 1000) / 1000;
    if (period < .5 || period > duration - 1) continue;
    let matches = true;
    for (let i = 0; i < offsets.length; i++) {
      if (changedPixels(reference[i], await frameAt(offsets[i] + period)) > limit) { matches = false; break; }
    }
    if (matches) return period;
  }
  return null;
}

/**
 * 逐层烘焙：同一场景实例里每次只显示一个目标图层（祖先保留可见但透明），透明底逐帧出图。
 * 渲染器按预乘透明度写入画布，读出后除以透明度还原；按所有帧的内容范围裁切后送出。
 */
async function bake(bridge: RecorderBridge, job: RecordJob) {
  Object.assign(stage.style, { width: job.full.width + 'px', height: job.full.height + 'px' });
  const scene = await load({ ...job, playing: true, dpr: 1 });
  if (!scene) throw new Error('壁纸未能加载');
  const control = editorOf(scene);
  if (!control) throw new Error('当前壁纸不支持逐层烘焙');
  const started = performance.now();
  while (performance.now() - started < 2500 || performance.now() - lastRead < 1000) {
    if (performance.now() - started > 20000) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  scene.pause();
  const layers = control.getLayers().filter(layer => layer.kind !== 'group');
  const parents = new Map(layers.map(layer => [layer.id, layer.parentId]));
  const original = new Map(layers.map(layer => [layer.id, control.getLayerProps(layer.id)]));
  // 直接读取 WebGL 缓冲的原始像素：经 2D 画布复制会丢掉透明度为 0 的像素颜色（加法发光就存在这里）。
  const canvas = scene.canvas, gl = canvas.getContext('webgl2')!;
  const W = canvas.width, H = canvas.height, scale = W / job.sceneWidth, matting = bakeMatte(gl, W, H);
  // 静止判断：第 1、2 秒与第 0 帧相比，变化像素数都不超过整幅的万分之一。
  const limit = Math.max(4, W * H / 10000);
  let time = control.time;
  try {
    for (const target of job.targets!) {
      const together = new Set([target, ...(job.members?.[target] ?? [])]), ancestors = new Set<number>();
      for (const member of together) for (let id = parents.get(member); id != null; id = parents.get(id) ?? null) ancestors.add(id);
      for (const layer of layers) {
        const props = original.get(layer.id);
        // 图片类上级的透明度不传给子层，设为 0 只隐藏自身；合成层、全屏层等把子层画进自身缓冲，需保持原透明度。
        if (together.has(layer.id)) await control.setLayerProps(layer.id, { visible: props?.visible ?? true, alpha: props?.alpha ?? 1 });
        else if (ancestors.has(layer.id)) await control.setLayerProps(layer.id, { visible: props?.visible ?? true, alpha: layer.kind === 'image' ? 0 : props?.alpha ?? 1 });
        else if (layer.visible) await control.setLayerProps(layer.id, { visible: false });
      }
      let single = !!job.particles?.includes(target);
      matte.clear = single ? 'transparent' : 'black';
      for (let i = 0; i < job.warmup; i++) { time += 1 / job.fps; await control.seek(time); }
      if (!single) {
        // 同一时刻黑底连渲两次：画面不一致说明这一层每次渲染都带随机成分（与粒子相同），
        // 黑白两次抠图会把差异算成透明小洞（孤独の少女人物层），改用透明底单次渲染。
        await control.seek(time); matting.copy();
        await control.seek(time + 1e-4); matting.copy(true);
        const probe = matting.frame(false);
        let differ = 0;
        for (let i = 3; i < probe.length; i += 4) if (probe[i] < 200) differ++;
        single = differ > 2;
        matte.clear = single ? 'transparent' : 'black';
      }
      const frames: Uint8Array[] = [], samples: Float32Array[] = [];
      const start = time + 1 / job.fps, { probeFrames, fade } = job as RecordJob & { probeFrames: number; fade: number };
      const frameAt = async (seconds: number) => {
        const at = start + seconds;
        if (single) { await control.seek(at); matting.copy(); }
        else {
          matte.clear = 'black'; await control.seek(at); matting.copy();
          // 白底那次只推进万分之一秒，脚本与动画状态几乎不变。
          matte.clear = 'white'; await control.seek(at + 1e-4); matting.copy(true); matte.clear = 'black';
        }
        return matting.frame(single);
      };
      let left = W, top = H, right = -1, bottom = -1, fallbackBounds: number[] = [];
      // 粒子和每次渲染都带随机成分的图层不会逐像素重复，只取原来的帧数，不做长观察与周期搜索。
      const observe = single ? job.frames : probeFrames;
      for (let i = 0; i < observe; i++) {
        const data = await frameAt(i / job.fps);
        // 只保留原来四秒加淡化的完整帧，长观察段只存分块特征，内存不随上限时长增长。
        if (i < job.frames) frames.push(data);
        samples.push(bakeSignature(data, W, H));
        for (let y = 0; y < H; y++) {
          const row = y * W * 4;
          let x = 0;
          while (x < W && !data[row + x * 4 + 3]) x++;
          if (x === W) continue;
          let end = W - 1;
          while (!data[row + end * 4 + 3]) end--;
          if (x < left) left = x; if (end > right) right = end; if (y < top) top = y; if (y > bottom) bottom = y;
        }
        if (i === job.frames - 1) fallbackBounds = [left, top, right, bottom];
        if (i === job.fps * 2 && changedPixels(frames[0], frames[job.fps]) <= limit && changedPixels(frames[0], data) <= limit) { frames.length = 1; break; }
      }
      const still = frames.length === 1;
      const period = still || single ? null : await detectBakePeriod(samples, job.fps, W, H, frameAt, limit);
      if (!still && period === null) [left, top, right, bottom] = fallbackBounds;
      time = start + (samples.length - 1) / job.fps;
      if (right < 0) { await bridge.layer({ id: target, width: 0, height: 0, count: 0, bbox: [] }); continue; }
      const width = right - left + 1, height = bottom - top + 1;
      const count = period === null ? frames.length : Math.round(period * job.fps), fps = period === null ? job.fps : count / period;
      const meta = { id: target, width, height, count, fps, period, fade: still || period !== null ? 0 : fade,
        bbox: [left / scale, top / scale, width / scale, height / scale], still };
      await bridge.layer(meta);
      if (period !== null) frames.length = 0;
      for (let i = 0; i < count; i++) {
        const data = period === null ? frames[i] : await frameAt(i / fps);
        const cropped = new Uint8Array(width * height * 4);
        for (let y = 0; y < height; y++) cropped.set(data.subarray(((top + y) * W + left) * 4, ((top + y) * W + left + width) * 4), y * width * 4);
        await bridge.frame(cropped);
      }
    }
    await bridge.done();
  } finally { matting.destroy(); }
}

const RealDate = Date, midnight = new RealDate();
midnight.setHours(0, 0, 0, 0);
let clockOrigin = 0, clockStarted = 0;
const clockNow = () => clockOrigin + performance.now() - clockStarted;

/** 可重复设置的模拟时钟：以真实日期的零点为基准，设置后继续随真实时间走动。 */
function fixClock(minute: number, day = 0) {
  clockOrigin = midnight.getTime() + day * 86400000 + minute * 60000;
  clockStarted = performance.now();
  (globalThis as { Date: DateConstructor }).Date = class extends RealDate {
    constructor(...args: unknown[]) { super(...((args.length ? args : [clockNow()]) as [number])); }
    static now() { return clockNow(); }
  } as DateConstructor;
}

const observeTolerance = { visible: 0, effective: 0, origin: 0.5, scale: 0.004, angles: 0.001, alpha: 0.004, color: 0.004, brightness: 0.004 };

/** 完整场景先读完资源，再按请求逐个设置时钟；分组与普通图层采用相同的属性读取接口。 */
async function observe(bridge: RecorderBridge, job: RecordJob) {
  let request = await bridge.next(null);
  if (!request) { await bridge.done(); return; }
  const now = performance.now.bind(performance);
  let clockOffset = 1000;
  // 每个请求推进一秒渲染时钟，让 engine.timeOfDay 的按秒缓存立即刷新。
  performance.now = () => now() + clockOffset;
  fixClock(request.minute, request.day);
  Object.assign(stage.style, { width: job.full.width + 'px', height: job.full.height + 'px' });
  const scene = await load({ ...job, patch: { ...job.patch, keep: undefined }, playing: true, dpr: 1 });
  if (!scene) throw new Error('壁纸未能加载');
  const control = editorOf(scene)!;
  const started = performance.now();
  while (performance.now() - started < 2500 || performance.now() - lastRead < 1000) {
    if (performance.now() - started > 20000) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  scene.pause();
  const read = (): ObserveLayer[] => control.getLayers().map(layer => ({
    id: layer.id, kind: layer.kind, effective: layer.visible, ...control.getLayerProps(layer.id)!,
  }));
  // 已发现的动画字段继续读取和报告，后续采样只跳过它们的稳定判断。
  const animated = new Set<string>();
  let time = control.time;
  while (request) {
    let previous = read(), consecutive = 0;
    const stable = new Map(previous.map(layer => [layer.id, Object.fromEntries(Object.keys(observeTolerance).map(field => [field, 0]))]));
    for (let step = 0; step < 15 && consecutive < 2; step++) {
      time += 0.2;
      await control.seek(time);
      const current = read(), before = new Map(previous.map(layer => [layer.id, layer]));
      let unchanged = true;
      for (const layer of current) {
        const last = before.get(layer.id)!, fields = stable.get(layer.id)!;
        for (const field of Object.keys(observeTolerance) as (keyof typeof observeTolerance)[]) {
          const value = layer[field], old = last[field];
          const same = Array.isArray(value)
            ? value.every((item, i) => Math.abs(item - (old as number[])[i]) <= observeTolerance[field])
            : Math.abs(Number(value) - Number(old)) <= observeTolerance[field];
          fields[field] = same ? fields[field] + 1 : 0;
          if (!same && !animated.has(`${layer.id}:${field}`)) unchanged = false;
        }
      }
      consecutive = unchanged ? consecutive + 1 : 0;
      previous = current;
    }
    const unstable = Object.fromEntries([...stable].map(([id, fields]): [number, string[]] => [id, Object.keys(fields).filter(field => fields[field] < 2)]).filter(([, fields]) => fields.length));
    for (const [id, fields] of Object.entries(unstable)) for (const field of fields) animated.add(`${id}:${field}`);
    request = await bridge.next({ ...request, layers: previous, unstable });
    if (request) {
      clockOffset += 1000;
      fixClock(request.minute, request.day);
    }
  }
  await bridge.done();
}

/** 直接读取最终 WebGL 画面，避免二维画布在复制时进行颜色与透明度换算。 */
function lutPixels(canvas: HTMLCanvasElement) {
  const gl = canvas.getContext('webgl2')!, read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
  try {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return pixels;
  } finally { gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read); }
}

/** 隐藏全部调色层校准输入，再逐个显示目标测输出，共用色块与窗口。 */
async function measureLut(bridge: RecorderBridge, job: RecordJob) {
  Object.assign(stage.style, { width: job.full.width + 'px', height: job.full.height + 'px' });
  const targets = job.lut!.targets ?? [job.patch.keep![0]];
  const grid: LutGrid = { size: job.lut!.size, targets, tiles: [], primary: [], checks: [] };
  const scene = await load({ ...job, patch: { ...job.patch, keep: targets }, playing: true, dpr: 1 }, grid);
  if (!scene) throw new Error('壁纸未能加载');
  const control = editorOf(scene)!;
  const started = performance.now();
  while (performance.now() - started < 2500 || performance.now() - lastRead < 1000) {
    if (performance.now() - started > 20000) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  scene.pause();
  await Promise.all(targets.map(target => control.setLayerProps(target, { visible: false })));
  const canvas = scene.canvas, W = canvas.width, H = canvas.height;
  const sample = (pixels: Uint8Array, tile: LutTile, channel: number) => pixels[(Math.floor((1 - tile.y) * H) * W + Math.floor(tile.x * W)) * 4 + channel];
  let input = lutPixels(canvas), inputError = 0;
  for (const tile of grid.tiles) for (let c = 0; c < 3; c++) inputError = Math.max(inputError, Math.abs(sample(input, tile, c) - tile.color[c] * 255));
  const low = grid.tiles.map(() => [0, 0, 0]), high = grid.tiles.map(() => [1, 1, 1]);
  const values = grid.tiles.map(tile => [...tile.color] as [number, number, number]);
  for (let step = 0; step < 12; step++) {
    const changes: Promise<void>[] = [];
    grid.tiles.forEach((tile, i) => {
      let changed = false;
      for (let c = 0; c < 3; c++) {
        const actual = sample(input, tile, c), nominal = tile.color[c] * 255;
        if (Math.abs(actual - nominal) <= 0.5) continue;
        if (actual < nominal) low[i][c] = values[i][c]; else high[i][c] = values[i][c];
        values[i][c] = (low[i][c] + high[i][c]) / 2;
        changed = true;
      }
      if (changed) changes.push(control.setLayerProps(tile.id, { color: values[i] }));
    });
    if (!changes.length) break;
    // 同一轮的所有颜色一起写入，只让渲染器补画一帧。
    await Promise.all(changes);
    input = lutPixels(canvas);
  }
  const results: Record<number, LutResult> = {};
  for (const target of targets) {
    await control.setLayerProps(target, { visible: true });
    const output = lutPixels(canvas), table = new Array<number>(grid.size ** 3 * 3);
    for (const tile of grid.primary) for (let c = 0; c < 3; c++) table[tile.index * 3 + c] = sample(output, tile, c);
    // 轮廓使用渲染器已经合成上级变换后的屏幕坐标，判断调色层是否覆盖四个画布角。
    const corners = control.getLayerOutline(target)?.corners;
    let positional = !corners || ![[0, 0], [canvas.clientWidth, 0], [canvas.clientWidth, canvas.clientHeight], [0, canvas.clientHeight]].every(([x, y]) => {
      const cross = corners.map((a, i) => { const b = corners[(i + 1) % corners.length]; return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]); });
      return cross.every(value => value >= -0.01) || cross.every(value => value <= 0.01);
    });
    for (const tiles of grid.checks) for (let c = 0; c < 3; c++) {
      const colors = [table[tiles[0].index * 3 + c], ...tiles.map(tile => sample(output, tile, c))];
      if (Math.max(...colors) - Math.min(...colors) > 3) positional = true;
    }
    results[target] = { size: grid.size, table, positional, inputError };
    await control.setLayerProps(target, { visible: false });
  }
  await bridge.done(results);
}

async function record(bridge: RecorderBridge) {
  const job = await bridge.job();
  if (job.mode === 'observe') return observe(bridge, job);
  if (job.minute !== undefined) fixClock(job.minute);
  if (job.mode === 'lut') return measureLut(bridge, job);
  if (job.mode === 'capture') return capture(bridge, job);
  if (job.mode === 'bake') { matteBackground(); return bake(bridge, job); }
  const step = job.mode === 'step';
  // 逐帧模式把画布设为整幅尺寸后从中裁出录制区域；实时模式用样式把录制区域对齐到窗口。
  Object.assign(stage.style, step
    ? { width: job.full.width + 'px', height: job.full.height + 'px' }
    : { width: job.sceneWidth + 'px', height: job.sceneHeight + 'px', transformOrigin: '0 0',
      transform: `translate(${-job.crop.x}px,${-job.crop.y}px) scale(${job.full.width / job.sceneWidth})` });
  const scene = await load({ ...job, playing: true, dpr: 1 });
  if (!scene) throw new Error('壁纸未能加载');
  if (!step) { await bridge.ready(); return; }
  const control = editorOf(scene);
  if (!control) throw new Error('当前壁纸不支持逐帧录制');
  // 贴图与粒子资源在首帧后仍会陆续解码上传；先实时播放到资源读取停止，再转为逐帧录制。
  const started = performance.now();
  while (performance.now() - started < 2500 || performance.now() - lastRead < 1000) {
    if (performance.now() - started > 20000) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  scene.pause();
  const output = document.createElement('canvas');
  output.width = job.crop.width; output.height = job.crop.height;
  const context = output.getContext('2d', { willReadFrequently: true })!;
  // 从实时播放到的时刻继续逐帧推进，粒子与脚本保持连续状态。
  let time = control.time;
  for (let i = 0; i < job.warmup; i++) { time += 1 / job.fps; await control.seek(time); }
  for (let i = 0; i < job.frames; i++) {
    time += 1 / job.fps;
    const frame = await control.captureFrame({ time });
    context.clearRect(0, 0, output.width, output.height);
    context.drawImage(frame, job.crop.x, job.crop.y, job.crop.width, job.crop.height, 0, 0, output.width, output.height);
    const pixels = context.getImageData(0, 0, output.width, output.height).data;
    await bridge.frame(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));
  }
}

if (recording && window.recorder) {
  const bridge = window.recorder;
  void record(bridge).catch(error => bridge.fail((error as Error).message || String(error)));
} else {
  addEventListener('message', receive);
  post({ type: 'booted' });
}
