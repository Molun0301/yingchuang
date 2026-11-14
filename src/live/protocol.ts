// 主界面与渲染页之间的消息格式。渲染页运行壁纸自带脚本，只通过消息接收指令。
export type LiveTheme = {
  key: string;
  type: string;
  /** 主题目录地址，以 / 结尾 */
  base: string;
  /** 壁纸引擎内置资源目录地址，散装工程缺文件时回落读取 */
  engine: string;
  file: string;
  pkg: boolean;
  project: unknown;
};
/** 打开前对 scene.json 做的覆盖：隐藏原时钟文字层、图层编辑、用户字体映射 */
export type LivePatch = { hidden: number[]; layers: Record<string, Record<string, unknown>>; fonts: Record<string, string>;
  /** 逐层烘焙：场景底色换成透明，单层画面带透明通道 */
  transparent?: boolean;
  /** 观察到的自身状态，直接替换场景字段及其用户属性绑定 */
  state?: Record<string, { visible?: boolean; alpha?: number; color?: string; origin?: string; scale?: string; angles?: string; brightness?: number; text?: string }>;
  /** 逐层烘焙：只保留这些图层及其上级，其余对象不载入，降低每帧渲染开销 */
  keep?: number[] };
export type LiveLoad = { theme: LiveTheme; properties: Record<string, unknown>; patch: LivePatch; playing: boolean; dpr: number };
export type LiveInfo = { width: number; height: number; layerCount: number; hasModels: boolean; hasParticles: boolean; hasText: boolean;
  /** 图层模式预览：各层感应倍数的最大值，编辑器据此按手机公式留出感应边距 */
  maxMotion?: number };

export type ParentMessage =
  | ({ type: 'load' } & LiveLoad)
  | { type: 'properties'; properties: Record<string, unknown> }
  | { type: 'playing'; playing: boolean }
  | { type: 'audio'; left: number[]; right: number[] }
  | { type: 'dpr'; dpr: number }
  /** 图层模式预览的逐层感应：倍数为 1 的图层应有的位移（场景单位，x 向右、y 向下） */
  | { type: 'parallax'; x: number; y: number }
  /** 预览时刻（当天第几分钟）；null 为跟随当前时间 */
  | { type: 'clock'; minute: number | null };

export type ChildMessage =
  | { type: 'booted' }
  | { type: 'ready'; info: LiveInfo | null; ms: number }
  | { type: 'error'; message: string }
  | { type: 'diagnostic'; level: string; message: string };

export type ObserveRequest = { day: number; minute: number };
export type ObserveLayer = {
  id: number; kind: string; visible: boolean; effective: boolean; alpha: number; brightness: number;
  color: [number, number, number]; origin: [number, number, number]; scale: [number, number, number]; angles: [number, number, number];
};
export type ObserveSnapshot = ObserveRequest & { layers: ObserveLayer[]; unstable: Record<string, string[]> };
export type LutResult = { size: number; table: number[]; positional: boolean; inputError: number };

/** 录制任务：step 为场景逐帧确定性出图；realtime 为网页等实时画面，由主进程采集 */
export type RecordJob = LiveLoad & {
  /** step：场景逐帧；realtime：网页离屏实时；capture：桌面采集；bake：逐层烘焙；observe：观察；lut：测量查色表 */
  mode: 'step' | 'realtime' | 'capture' | 'bake' | 'observe' | 'lut';
  /** 查色表目标按绘制顺序从下到上排列，共用一个测量窗口。 */
  lut?: { size: number; targets?: number[] };
  /** bake 模式：逐个单独渲染的图层编号；其中的粒子系统用透明底单次渲染 */
  targets?: number[];
  particles?: number[];
  /** 与目标一起渲染成一层的下方图层（合成层取下方画面再处理） */
  members?: Record<number, number[]>;
  /** 随时段变化的变体按一天中的这一分钟渲染 */
  minute?: number;
  /** capture 模式：被采集窗口、排版与感应留边，裁切在页面按实际窗口比例计算 */
  sourceId?: string;
  layout?: { scale: number; x: number; y: number };
  margin?: { x: number; y: number };
  fps: number;
  frames: number;
  warmup: number;
  sceneWidth: number;
  sceneHeight: number;
  /** 整幅场景按背屏缩放后的像素尺寸 */
  full: { width: number; height: number };
  /** 录制区域在整幅画面中的位置，以及输出尺寸 */
  crop: { x: number; y: number; width: number; height: number };
};
