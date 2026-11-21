// 导出页：画质与上次导出的结果；录制模式下的循环时长、帧率与首尾过渡。
import type { Build, Device, Project, ThemeDetail } from '../types';
import { Slider, Toggle } from '../controls';
import { Segmented } from '../ui';
import { frameScene, recordSize } from '../live/framing';

type Props = { data: ThemeDetail; project: Project; update: (change: (project: Project) => void, key?: string) => void; device: Device; mode: 'full' | 'native'; build?: Build };
const qualityNames = { compact: '省空间', standard: '标准', high: '高清' } as const;
const when = (time: number) => new Date(time).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function ExportPanel({ data, project, update, device, mode, build }: Props) {
  const settings = project.export, set = (patch: Partial<Project['export']>, key?: string) => update(p => { p.export = { ...p.export, ...patch }; }, key);
  const framing = frameScene(data.live.sceneSize[0], data.live.sceneSize[1], device.width, device.height, project.framing, project.motion.amount, project.motion.vertical);
  const size = recordSize(device.width, device.height, framing), frames = Math.round(settings.duration * settings.fps);
  const megabytes = Math.max(.5, settings.duration * 3.2 / 8 * size.width * size.height / 613000 * settings.fps / 30);
  return <>
    <div className="inspector-section"><div className="section-title">画质</div>
      <Segmented glass={false} label="导出画质" value={settings.quality} onChange={quality => set({ quality })} options={(['compact', 'standard', 'high'] as const).map(value => ({ value, label: qualityNames[value] }))}/>
      {build && <div className="estimate"><span>上次导出 · {qualityNames[build.quality]}</span><span>{(build.size / 1048576).toFixed(1)} MB · {when(build.createdAt)}</span></div>}
    </div>
    {mode === 'full' && <div className="inspector-section"><div className="section-title">录制</div>
      <Slider label="循环时长" value={settings.duration} min={2} max={30} suffix=" 秒" onChange={v => set({ duration: v }, 'duration')}/>
      <div className="field-heading"><span>帧率</span></div>
      <Segmented glass={false} label="录制帧率" value={String(settings.fps)} onChange={v => set({ fps: Number(v) })} options={[24, 30, 60].map(n => ({ value: String(n), label: `${n} 帧` }))}/>
      <Toggle label="首尾交叉过渡" checked={settings.loop} onChange={v => set({ loop: v })}/>
      {settings.loop && <Slider label="过渡时长" value={settings.fade} min={.1} max={2} step={.1} digits={1} suffix=" 秒" onChange={v => set({ fade: v }, 'fade')}/>}
      <div className="estimate"><span>{size.width} × {size.height}</span><span>{frames} 帧 · 约 {megabytes.toFixed(1)} MB</span></div>
    </div>}
  </>;
}
