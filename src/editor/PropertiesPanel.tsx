// 壁纸设置页：壁纸作者提供的设置项（按作者条件显示），视频壁纸另有播放速度与导出音量。
import { useState } from 'react';
import { RotateCcw, Search } from 'lucide-react';
import type { Project, Theme, ThemeDetail } from '../types';
import { PropertyControl, Slider } from '../controls';
import { conditionVisible } from '../conditions';

type Props = { theme: Theme; data: ThemeDetail; project: Project; update: (change: (project: Project) => void, key?: string) => void };

export function PropertiesPanel({ theme, data, project, update }: Props) {
  const [search, setSearch] = useState('');
  const shown = data.properties.filter(p => p.type !== 'text' && conditionVisible(p.condition, project.properties) && (!search || p.label.toLowerCase().includes(search.toLowerCase())));
  return <>
    {data.properties.length > 6 && <label className="inspector-search"><Search size={14}/><input placeholder="查找壁纸设置" value={search} onChange={e => setSearch(e.target.value)}/></label>}
    {theme.type === 'video' && <><Slider label="播放速度" value={Number(project.properties.__videoSpeed ?? 1)} min={.25} max={2} step={.05} digits={2} suffix="×" onChange={v => update(p => { p.properties.__videoSpeed = v; }, 'video-speed')}/>
      <Slider label="导出音量" value={Number(project.properties.__videoVolume ?? 0) * 100} min={0} max={100} suffix="%" onChange={v => update(p => { p.properties.__videoVolume = v / 100; }, 'video-volume')}/></>}
    <div className="property-fields">{shown.map(p => <PropertyControl key={p.key} property={p} value={project.properties[p.key] ?? p.value} onChange={value => update(d => { d.properties[p.key] = value; }, 'property-' + p.key)}/>)}
      {!shown.length && theme.type !== 'video' && <div className="empty-small">{search ? '没有匹配的设置' : '这张壁纸没有可调设置'}</div>}</div>
    {data.properties.length > 0 && <button className="text-button" onClick={() => update(d => { d.properties = { ...d.properties, ...Object.fromEntries(data.properties.filter(p => 'value' in p).map(p => [p.key, p.value])) }; })}><RotateCcw size={13}/>恢复壁纸设置</button>}
  </>;
}
