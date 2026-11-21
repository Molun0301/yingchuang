// 图层页：带缩略图的图层列表（点预览画面也能选中），选中图层的位置、缩放、透明度等。
import { Eye, EyeOff, Image as ImageIcon, Type, Sparkles, RotateCcw, Info } from 'lucide-react';
import type { FontOption, Project, SourceLayer, ThemeDetail } from '../types';
import { Slider, Toggle } from '../controls';
import { Select } from '../Select';
import { colorHex, sourceColor } from '../conditions';

type Props = { data: ThemeDetail; project: Project; update: (change: (project: Project) => void, key?: string) => void; fonts: FontOption[]; onFonts: (fonts: FontOption[]) => void;
  selected: string; onSelect: (id: string) => void; thumbnails: Record<string, string> };
const kindIcon = { text: Type, particle: Sparkles, image: ImageIcon } as const;

export function LayersPanel({ data, project, update, fonts, onFonts, selected, onSelect, thumbnails }: Props) {
  const layer = data.detail.layers.find(item => item.id === selected);
  const value = (key: string) => project.layers[selected]?.[key] ?? layer?.[key as keyof SourceLayer];
  const change = (key: string, next: unknown, history?: string) => update(p => { p.layers[selected] = { ...p.layers[selected], [key]: next }; }, history);
  const visible = (item: SourceLayer) => (project.layers[item.id]?.visible ?? item.visible) !== false;
  const control = layer?.visibleProperty ? data.properties.find(property => property.key === layer.visibleProperty) : undefined;
  return <>
    <div className="layer-list">{[...data.detail.layers].reverse().map(item => { const Icon = kindIcon[item.kind as keyof typeof kindIcon] || ImageIcon; return <div key={item.id} className={`layer-row ${item.id === selected ? 'selected' : ''} ${visible(item) ? '' : 'hidden-layer'}`}>
      <button className="layer-row-main" onClick={() => onSelect(item.id)}><span className="layer-thumb">{thumbnails[item.id] ? <img src={thumbnails[item.id]} alt=""/> : <Icon size={14}/>}</span><span>{item.name || `图层 ${item.id}`}</span></button>
      <button className="icon-button" aria-label={visible(item) ? `隐藏${item.name}` : `显示${item.name}`} title={visible(item) ? '隐藏' : '显示'} onClick={() => update(p => { p.layers[item.id] = { ...p.layers[item.id], visible: !visible(item) }; })}>{visible(item) ? <Eye size={14}/> : <EyeOff size={14}/>}</button>
    </div>; })}</div>
    {layer && <div className="inspector-section"><div className="section-title">{layer.name || `图层 ${layer.id}`}</div>
      <Toggle label="显示图层" checked={Boolean(value('visible'))} onChange={v => change('visible', v)}/>
      {control && <div className="hint"><Info size={13}/>{project.layers[selected]?.visible === undefined ? `显示由壁纸设置“${control.label}”控制，在这里开关会把它固定下来。` : `已固定显示状态，壁纸设置“${control.label}”不再控制它；点下方“恢复此图层”可交还。`}</div>}
      <Slider label="横向位置" value={Number(value('x')) * 100} min={-100} max={200} suffix="%" onChange={v => change('x', v / 100, 'layer-x')}/>
      <Slider label="纵向位置" value={Number(value('y')) * 100} min={-100} max={200} suffix="%" onChange={v => change('y', v / 100, 'layer-y')}/>
      <Slider label="缩放" value={Number(project.layers[selected]?.scale ?? 1) * 100} min={1} max={300} suffix="%" onChange={v => change('scale', v / 100, 'layer-scale')}/>
      <Slider label="旋转" value={Number(project.layers[selected]?.rotation ?? 0)} min={-180} max={180} suffix="°" onChange={v => change('rotation', v, 'layer-rotation')}/>
      <Slider label="不透明度" value={Number(value('alpha')) * 100} min={0} max={100} suffix="%" onChange={v => change('alpha', v / 100, 'layer-alpha')}/>
      <label className="color-field"><span>颜色</span><input aria-label="图层颜色" type="color" value={colorHex(value('color'))} onChange={e => change('color', sourceColor(e.target.value), 'layer-color')}/></label>
      {layer.kind === 'text' && <><label className="stack-field"><span>文字内容</span><textarea aria-label="文字内容" value={String(value('text') ?? '')} onChange={e => change('text', e.target.value, 'layer-text')}/></label>
        <label className="stack-field"><span>字体</span><Select aria-label="图层字体" value={String(project.layers[selected]?.font || '')} onChange={async e => {
          const next = e.target.value;
          if (next === '__file') { const file = await window.yingchuang.chooseFile('font'); if (file) { onFonts([{ value: file, label: file.split(/[\\/]/).pop() || file }, ...fonts]); change('font', file); } } else change('font', next);
        }}><option value="">原图层字体</option><optgroup label="壁纸内置字体">{data.detail.fonts.map((f, i) => <option key={i} value={f.value}>{f.label}</option>)}</optgroup><optgroup label="本机字体">{fonts.map((f, i) => <option key={i} value={f.value}>{f.label}</option>)}</optgroup><option value="__file">选择字体文件…</option></Select></label>
        <Slider label="字号" value={Number(value('fontsize'))} min={8} max={160} onChange={v => change('fontsize', v, 'layer-fontsize')}/></>}
      <button className="text-button" onClick={() => update(p => { delete p.layers[selected]; })}><RotateCcw size={13}/>恢复此图层</button>
    </div>}
  </>;
}
