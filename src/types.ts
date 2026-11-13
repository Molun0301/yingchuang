import type { Appearance } from './appearance';
import type { LivePatch, LiveTheme } from './live/protocol';
export type RowKey = (typeof import('../core/组件.json'))['widgets'][number]['key'];
export type RowLayout = { visible: boolean; x: number; y: number; size: number; align: 'left' | 'center' | 'right'; label?: boolean; text?: string };
export type Layout = { scale: number; x: number; y: number; flip: boolean; clock: { enabled: boolean; language: 'en' | 'zh'; format: 'auto' | '24' | '12'; seconds: boolean; rows: Record<RowKey, RowLayout> } };
export type Draft = { version: number; deviceId: string; layout: Layout;
  appearance: { fonts: Record<RowKey,string>; colors: Record<RowKey,string> };
  motion: { amount: number; sensitivity: number; smoothing: number; vertical: number; fps: number };
  properties: Record<string,unknown>; layers: Record<string,Record<string,unknown>>; export?: ExportSettings };
/** 完整画面录制参数；mode 同时决定编辑器预览方式 */
export type ExportSettings = { mode: 'layers' | 'record'; duration: number; fps: number; loop: boolean; fade: number; quality: 'compact' | 'standard' | 'high' };
export type Device = { id: string; name: string; series: string; width: number; height: number; safeLeft: number; source: string; camera: { x: number; ys: number[]; r: number }; cornerRadius: number; cameraSource: string };
export type Theme = { id: string; title: string; type: string; preview: string; author: string; workshopId: string; modified: number; propertyCount: number };
export type Property = { key: string; type: string; label: string; value?: unknown; min?: number; max?: number; step?: number; precision?: number; fraction?: boolean; condition?: string; options?: { label: string; value: unknown }[] };
export type Template = { id: string; name: string; builtin?: boolean; layout: { scale: number; x: number; y: number; clockEnabled?:boolean; language?: 'en' | 'zh'; rows: Partial<Record<RowKey,RowLayout>> } };
export type QueueItem = { id: string; themeId: string; title: string; deviceId: string; status: 'waiting' | 'running' | 'done' | 'error' | 'cancelled'; progress: number; phase: string; error?: string; path?: string; folder?: string; notes?: number; mode?: 'layers' | 'record'; size?: number };
export type Settings = { roots: string[]; outputDirectory: string; deviceId: string; appearance?: Partial<Appearance> };
export type AppState = { themes: Theme[]; roots: string[]; favorites: string[]; templates: Template[]; settings: Settings; devices: Device[]; queue: QueueItem[]; version: string; platform: string };
export type FontOption = { label: string; value: string };
export type SourceLayer = { id: string; name: string; kind: string; visible: boolean; x: number; y: number; text: string; color: string; font?:string; alpha: number; fontsize: number };
export type ThemeDetail = { theme: Theme; properties: Property[]; draft: Draft;
  detail: { hasClock: boolean; fonts: FontOption[]; sourceFonts: Partial<Record<RowKey,string>>; sourceColors: Partial<Record<RowKey,string>>;
    fontIssue: string; layers: SourceLayer[]; sourceSize: [number,number] | null; renderable: boolean; reason?: string; clockLayerIds?: number[] };
  live: { theme: LiveTheme; renderer: string; available: boolean; sceneSize: [number,number] } };
export type SceneLayer = { id: string|number; name?: string; asset: string; video?:string; videoSource?:string; x: number; y: number; w: number; h: number; rotation: number; motion: number;
  sequence?: {frames: string[];period: number;times?: number[];mode?: string};travel?: number[][]; fade?: number[][];
  /** 随时段变化：一天内（分钟）的透明度关键点 */
  time?: number[][] };
export type ClockRow = { key: RowKey; size: number; w: number; h: number; y: number; nx?: number; ny?: number; visible?: boolean; sourceVisible?:boolean; align?: string;
  kind?: string; weekdays?: string[]; digits?: string[]; pieces?: { x: number; w: number; digit?: string; asset?: string }[];hourFormat?: string;
  segments?: Record<string,unknown>[]; digitW?: number; dot?: {asset:string;w:number}; minus?: {asset:string;w:number} };
export type Clock = { rows: ClockRow[]; assets: string[]; height: number; half_width: number; margin: number; fonts: Record<string,Record<string,unknown>>; warnings?: {key:RowKey;message:string}[] };
export type Preview = { width: number; height: number; title: string; layers: SceneLayer[]; restored: string[]; notes: string[];
  assetRoot: string; clockRoot: string; clock: Clock|null; config: Record<string,unknown>;videoSpeed?:number;progressive?:boolean;clockError?:string;background?:string;
  details?: Record<string,unknown> };
export type Bridge = {
  bootstrap(): Promise<AppState>; refresh(): Promise<AppState>; detail(id: string): Promise<ThemeDetail>; fonts(): Promise<FontOption[]>;
  saveDraft(id: string,draft: Draft): Promise<Draft>; livePatch(id: string, draft: Draft): Promise<LivePatch>; preview(id:string,draft:Draft,requestId?:number):Promise<Preview>; clock(id:string,draft:Draft):Promise<Pick<Preview,'clock'|'clockRoot'|'config'>>; cancelPreview():Promise<void>;
  previewMotion(id:string,requestId:number):Promise<void>; prefetch(id:string):Promise<void>;
  favorite(id:string):Promise<Partial<AppState>>;saveTemplate(name:string,layout:Layout):Promise<Partial<AppState>>;deleteTemplate(id:string):Promise<Partial<AppState>>;
  applyTemplate(ids:string[],id:string):Promise<AppState>;settings(settings:Partial<Settings>):Promise<AppState>;
  chooseDirectory(purpose:string):Promise<AppState|null>;removeDirectory(folder:string):Promise<AppState>;chooseFile(kind:string):Promise<string|null>;
  enqueue(input:{ids:string[];templateId?:string;deviceId?:string}):Promise<QueueItem[]>;cancelQueue(id?:string):Promise<QueueItem[]>;clearQueue():Promise<QueueItem[]>;
  openTheme(id:string):Promise<void>;openOutput(id?:string):Promise<void>;windowControl(action:string):Promise<void>;
  onQueue(callback:(items:QueueItem[])=>void):()=>void;onPreviewProgress(callback:(event:{id:string;phase:string;progress:number})=>void):()=>void;
  onPreviewReady(callback:(event:{id:string;requestId:number;data?:Preview;error?:string})=>void):()=>void;
  updateCheck():Promise<UpdateRelease>;updateDownload():Promise<UpdateDownload|null>;updateCancel():Promise<void>;
  updateInstall():Promise<{manual:boolean;message?:string}>;updateSettings(patch?:Partial<Pick<UpdateSettings,'auto'|'skipVersion'>>):Promise<UpdateStatus>;
  openRelease(url?:string):Promise<void>;onUpdate(callback:(event:UpdateEvent)=>void):()=>void;
};
declare global { interface Window { yingchuang: Bridge } }

export type UpdateSettings = { auto:boolean;skipVersion:string;lastCheck:number };
export type UpdateStatus = { current:string;canInstall:boolean;settings:UpdateSettings };
export type UpdateRelease = { current:string;latest:string;available:boolean;notes:string;url:string;publishedAt:string;
  asset:{name:string;size:number;digest:string|null;url:string}|null };
export type UpdateDownload = { path:string;version:string;canInstall:boolean };
export type UpdateProgress = { downloaded:number;total:number;percent:number;speed:number };
export type UpdateEvent = {type:'available';release:UpdateRelease}|{type:'progress';progress:UpdateProgress}|
  {type:'downloaded';download:UpdateDownload}|{type:'cancelled'}|{type:'error';message:string};
