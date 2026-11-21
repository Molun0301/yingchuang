import type { Appearance } from './appearance';
import type { LivePatch, LiveTheme } from './live/protocol';
export type WidgetKey = (typeof import('../core/组件.json'))['widgets'][number]['key'];
/** 旧名称，组件绘制与字形数据仍按组件键索引 */
export type RowKey = WidgetKey;
export type Align = 'left' | 'center' | 'right';
export type WidgetEffect = 'none' | 'shadow' | 'outline';
/** 一个组件的全部设置（作品 v2）。font、color 为空：时间、日期、星期沿用壁纸原有的，其余组件跟随时间组件 */
export type Widget = { key: WidgetKey; x: number; y: number; size: number; align: Align; font: string; color: string; effect: WidgetEffect;
  language: 'zh' | 'en'; label: boolean; text?: string; hourFormat?: 'auto' | '24' | '12'; seconds?: boolean };
export type Framing = { scale: number; x: number; y: number; flip: boolean };
export type Motion = { amount: number; sensitivity: number; smoothing: number; vertical: number; fps: number };
/** 导出选项；duration、fps、loop、fade 只用于录制模式 */
export type ExportSettings = { mode: 'layers' | 'record'; quality: 'compact' | 'standard' | 'high'; timeVariation: boolean; duration: number; fps: number; loop: boolean; fade: number };
/** 作品：对一张壁纸的全部编辑，与机型无关（机型是全局设置） */
export type Project = { version: 2; framing: Framing; showWidgets: boolean; widgets: Widget[]; motion: Motion;
  properties: Record<string, unknown>; layers: Record<string, Record<string, unknown>>; export: ExportSettings };
export type TemplateWidget = Pick<Widget, 'key' | 'x' | 'y' | 'size' | 'align'>;
export type Template = { id: string; name: string; builtin?: boolean; createdAt?: number;
  layout: { framing: { scale: number; x: number; y: number }; showWidgets: boolean; widgets: TemplateWidget[] } };
export type Device = { id: string; name: string; series: string; width: number; height: number; safeLeft: number; source: string; camera: { x: number; ys: number[]; r: number }; cornerRadius: number; cameraSource: string };
/** 壁纸。available 为 false 时当前系统无法转换，reason 直接显示给用户 */
export type Theme = { id: string; title: string; type: string; preview: string; author: string; workshopId: string; modified: number; propertyCount: number;
  available: boolean; reason?: string; preset?: { base: string; baseTitle: string; missing: boolean } };
export type Property = { key: string; type: string; label: string; value?: unknown; min?: number; max?: number; step?: number; precision?: number; fraction?: boolean; condition?: string; options?: { label: string; value: unknown }[] };
export type QueueItem = { id: string; themeId: string; title: string; deviceId: string; status: 'waiting' | 'running' | 'done' | 'error' | 'cancelled'; progress: number; phase: string;
  error?: string; mode?: 'layers' | 'record' | 'video'; size?: number; buildId?: string; createdAt: number; startedAt?: number; finishedAt?: number };
/** 成品：一张壁纸在一个机型上最近一次导出的结果 */
export type Build = { id: string; themeId: string; title: string; deviceId: string; mode: 'layers' | 'record' | 'video'; quality: ExportSettings['quality'];
  timeVariation: boolean; createdAt: number; file: string; size: number; notes: number; preview: string; fileExists: boolean; folderAvailable: boolean };
export type BuildReport = { notes: string[]; restored: string[]; layers: number; raw: Record<string, unknown> };
export type Settings = { roots: string[]; outputDirectory: string; deviceId: string; appearance?: Partial<Appearance>; timeVariationNotice?: boolean };
export type AppState = { themes: Theme[]; roots: string[]; favorites: string[]; templates: Template[]; settings: Settings; devices: Device[];
  queue: QueueItem[]; builds: Build[]; version: string; platform: string };
export type FontOption = { label: string; value: string };
/** box：图层在场景里的范围（0～1，左上为原点，[x0, y0, x1, y1]），无法确定时为 null */
export type SourceLayer = { id: string; name: string; kind: string; visible: boolean; x: number; y: number; text: string; color: string; font?: string; alpha: number; fontsize: number;
  box?: [number, number, number, number] | null;
  /** 显示由哪项壁纸设置控制（如“时间选择”切换的时段图层） */
  visibleProperty?: string | null };
export type ThemeDetail = { theme: Theme; properties: Property[]; project: Project;
  detail: { hasClock: boolean; fonts: FontOption[]; sourceFonts: Partial<Record<RowKey, string>>; sourceColors: Partial<Record<RowKey, string>>;
    fontIssue: string; layers: SourceLayer[]; sourceSize: [number, number] | null; renderable: boolean; reason?: string; clockLayerIds?: number[] };
  live: { theme: LiveTheme; renderer: string; available: boolean; sceneSize: [number, number] } };
export type SceneLayer = { id: string | number; name?: string; asset: string; video?: string; videoSource?: string; x: number; y: number; w: number; h: number; rotation: number; motion: number;
  sequence?: { frames: string[]; period: number; times?: number[]; mode?: string }; travel?: number[][]; fade?: number[][];
  /** 随时段变化：一天内（分钟）的透明度关键点 */
  time?: number[][] };
/** pad：字形图片四周为文字效果留出的边距（字形像素），绘制时按排版尺寸向外扩 */
export type ClockRow = { key: RowKey; size: number; w: number; h: number; y: number; language?: 'zh' | 'en'; nx?: number; ny?: number; visible?: boolean; sourceVisible?: boolean; align?: string;
  kind?: string; weekdays?: string[]; digits?: string[]; pieces?: { x: number; w: number; digit?: string; asset?: string }[]; hourFormat?: string;
  segments?: Record<string, unknown>[]; digitW?: number; dot?: { asset: string; w: number }; minus?: { asset: string; w: number }; pad?: number };
export type Clock = { rows: ClockRow[]; assets: string[]; height: number; half_width: number; margin: number; fonts: Record<string, Record<string, unknown>>; warnings?: { key: RowKey; message: string }[] };
export type Preview = { width: number; height: number; title: string; layers: SceneLayer[]; restored: string[]; notes: string[];
  assetRoot: string; clockRoot: string; clock: Clock | null; config: Record<string, unknown>; videoSpeed?: number; progressive?: boolean; clockError?: string; background?: string;
  details?: Record<string, unknown> };
export type Bridge = {
  bootstrap(): Promise<AppState>; refresh(): Promise<AppState>;
  /** 壁纸目录变化后自动重新扫描，推送新的完整状态 */
  onLibrary(callback: (state: AppState) => void): () => void;
  detail(id: string): Promise<ThemeDetail>; fonts(): Promise<FontOption[]>;
  /** 自动保存：界面持有作品状态，主进程只负责落盘 */
  saveProject(id: string, project: Project): Promise<void>;
  livePatch(id: string, project: Project): Promise<LivePatch>;
  /** 只用于视频等非场景壁纸的分层预览；场景壁纸在编辑器里一律实时渲染 */
  preview(id: string, project: Project, requestId?: number): Promise<Preview>; previewMotion(id: string, requestId: number): Promise<void>; cancelPreview(): Promise<void>;
  clock(id: string, project: Project): Promise<Pick<Preview, 'clock' | 'clockRoot' | 'config'>>;
  prefetch(id: string): Promise<void>;
  /** 图层缩略图地址，按图层编号索引 */
  layerThumbnails(id: string): Promise<Record<string, string>>;
  favorite(id: string): Promise<Partial<AppState>>;
  saveTemplate(name: string, project: Project): Promise<Partial<AppState>>; renameTemplate(id: string, name: string): Promise<Partial<AppState>>; deleteTemplate(id: string): Promise<Partial<AppState>>;
  /** 把模板写进这些壁纸的作品，不转换 */
  applyTemplate(ids: string[], templateId: string): Promise<AppState>;
  settings(settings: Partial<Settings>): Promise<AppState>;
  chooseDirectory(purpose: string): Promise<AppState | null>; removeDirectory(folder: string): Promise<AppState>; chooseFile(kind: string): Promise<string | null>;
  /** 按各自作品和全局机型转换，返回整个队列 */
  enqueue(input: { ids: string[] }): Promise<QueueItem[]>; cancelQueue(id?: string): Promise<QueueItem[]>; clearQueue(): Promise<QueueItem[]>;
  onQueue(callback: (items: QueueItem[]) => void): () => void;
  /** 成品记录变化（导出完成、删除）后推送 */
  onBuilds(callback: (builds: Build[]) => void): () => void;
  showBuild(id: string): Promise<void>; openOutput(): Promise<void>; buildReport(id: string): Promise<BuildReport>; buildPreview(id: string): Promise<string>; removeBuild(id: string): Promise<Build[]>;
  openTheme(id: string): Promise<void>; openWorkshop(workshopId: string): Promise<void>; windowControl(action: string): Promise<void>;
  onPreviewProgress(callback: (event: { id: string; phase: string; progress: number }) => void): () => void;
  onPreviewReady(callback: (event: { id: string; requestId: number; data?: Preview; error?: string }) => void): () => void;
  updateCheck(): Promise<UpdateRelease>; updateChangelog(): Promise<UpdateChangelog | null>; updateDownload(): Promise<UpdateDownload | null>; updateCancel(): Promise<void>;
  updateInstall(): Promise<{ manual: boolean; message?: string }>; updateSettings(patch?: Partial<Pick<UpdateSettings, 'auto' | 'skipVersion'>>): Promise<UpdateStatus>;
  openRelease(url?: string): Promise<void>; onUpdate(callback: (event: UpdateEvent) => void): () => void;
};
declare global { interface Window { yingchuang: Bridge } }

export type UpdateChangelog = { version:string;notes:string;url:string;publishedAt:string };
export type UpdateSettings = { auto:boolean;skipVersion:string;lastCheck:number;seenVersion?:string;pendingNotes?:UpdateChangelog };
export type UpdateStatus = { current:string;canInstall:boolean;settings:UpdateSettings };
export type UpdateRelease = { current:string;latest:string;available:boolean;notes:string;url:string;publishedAt:string;
  asset:{name:string;size:number;digest:string|null;url:string}|null };
export type UpdateDownload = { path:string;version:string;canInstall:boolean };
export type UpdateProgress = { downloaded:number;total:number;percent:number;speed:number };
export type UpdateEvent = {type:'available';release:UpdateRelease}|{type:'progress';progress:UpdateProgress}|
  {type:'downloaded';download:UpdateDownload}|{type:'cancelled'}|{type:'error';message:string};
