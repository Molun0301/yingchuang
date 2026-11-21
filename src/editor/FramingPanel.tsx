// 画面页：取景、翻转、感应与动效、排版模板（悬停预览、点击套用、保存当前排版）。
import { useState } from 'react';
import { Check, ChevronRight, Plus, X } from 'lucide-react';
import type { Project, Template } from '../types';
import { ResetButton, Slider, Toggle } from '../controls';
import { Select } from '../Select';
import { TemplateThumbnail } from '../TemplateThumbnail';

type Props = { project: Project; update: (change: (project: Project) => void, key?: string) => void; templates: Template[];
  onPreviewTemplate: (template: Template | null) => void; onApplyTemplate: (template: Template) => void; onSaveTemplate: (name: string) => Promise<void> };

export function FramingPanel({ project, update, templates, onPreviewTemplate, onApplyTemplate, onSaveTemplate }: Props) {
  const [naming, setNaming] = useState(false), [name, setName] = useState('');
  return <>
    <div className="inspector-section"><div className="section-title">取景<ResetButton label="重置取景" onClick={() => update(p => { p.framing.scale = 1.06; p.framing.x = .5; p.framing.y = .5; })}/></div>
      <Slider label="缩放" value={project.framing.scale * 100} min={20} max={300} suffix="%" onChange={v => update(p => { p.framing.scale = v / 100; }, 'scale')}/>
      <div className="two-fields"><label>水平<input aria-label="水平取景" type="number" min={0} max={100} value={Math.round(project.framing.x * 100)} onChange={e => update(p => { p.framing.x = Number(e.target.value) / 100; }, 'framing-x')}/></label>
        <label>垂直<input aria-label="垂直取景" type="number" min={0} max={100} value={Math.round(project.framing.y * 100)} onChange={e => update(p => { p.framing.y = Number(e.target.value) / 100; }, 'framing-y')}/></label></div>
      <Toggle label="水平翻转" checked={project.framing.flip} onChange={v => update(p => { p.framing.flip = v; })}/>
    </div>
    <details className="inspector-section advanced" open><summary><ChevronRight size={14}/>感应与动效</summary>
      <Slider label="感应幅度" value={project.motion.amount * 100} min={0} max={10} step={.1} digits={1} suffix="%" onChange={v => update(p => { p.motion.amount = v / 100; }, 'amount')}/>
      <Slider label="平滑程度" value={(1 - project.motion.smoothing) * 100} min={0} max={98} suffix="%" onChange={v => update(p => { p.motion.smoothing = 1 - v / 100; }, 'smoothing')}/>
      <label className="stack-field"><span>播放帧率</span><Select aria-label="播放帧率" value={project.motion.fps} onChange={e => update(p => { p.motion.fps = Number(e.target.value); })}>{[15, 24, 30, 60, 120].map(n => <option key={n} value={n}>{n} 帧 / 秒</option>)}</Select></label>
    </details>
    <div className="inspector-section"><div className="section-title">排版模板</div>
      <div className="template-picker" onMouseLeave={() => onPreviewTemplate(null)}>
        {templates.map(template => <button key={template.id} className="template-chip" title={`套用“${template.name}”`} onMouseEnter={() => onPreviewTemplate(template)} onFocus={() => onPreviewTemplate(template)} onBlur={() => onPreviewTemplate(null)}
          onClick={() => { onPreviewTemplate(null); onApplyTemplate(template); }}><TemplateThumbnail template={template} compact/><span>{template.name}</span></button>)}
      </div>
      {naming ? <form className="template-name" onSubmit={async e => { e.preventDefault(); await onSaveTemplate(name.trim() || '我的排版'); setNaming(false); setName(''); }}>
        <input autoFocus aria-label="模板名称" placeholder="模板名称" value={name} onChange={e => setName(e.target.value)}/>
        <button type="submit" className="icon-button" aria-label="保存模板"><Check size={17}/></button><button type="button" className="icon-button" aria-label="取消保存模板" onClick={() => setNaming(false)}><X size={15}/></button></form>
        : <button className="text-button" onClick={() => setNaming(true)}><Plus size={14}/>把当前排版存为模板</button>}
    </div>
  </>;
}
