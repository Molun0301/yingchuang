// 组件页：已放到画面上的组件列表 + 添加组件；选中的组件属性紧跟在列表下面。
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, X, Check, Info, AlignLeft, AlignCenter, AlignRight, Clock3, CalendarDays, Moon, Footprints, Route, Flame, Activity, Target, CloudSun, Thermometer, Droplets, Wind, Sunrise, Sunset, BatteryMedium, MessageSquare, PhoneMissed, Type } from 'lucide-react';
import type { FontOption, Project, ThemeDetail, Widget, WidgetKey } from '../types';
import { ColorWell, ResetButton, Slider, Toggle } from '../controls';
import { Select } from '../Select';
import { Segmented } from '../ui';
import { definitions, model, widgetSpec } from './model';

export const widgetIcons: Record<WidgetKey, typeof Clock3> = { time: Clock3, date: CalendarDays, week: CalendarDays, lunar: Moon, steps: Footprints, distance: Route, calories: Flame, active: Activity, goal: Target, weather: CloudSun, temperature: Thermometer, range: Thermometer, humidity: Droplets, air: Wind, sunrise: Sunrise, sunset: Sunset, battery: BatteryMedium, sms: MessageSquare, calls: PhoneMissed, text: Type };

type Props = { project: Project; update: (change: (project: Project) => void, key?: string) => void; data: ThemeDetail; fonts: FontOption[]; onFonts: (fonts: FontOption[]) => void;
  selection: WidgetKey[]; onSelect: (keys: WidgetKey[]) => void; focusFont: WidgetKey | null; onFocused: () => void };

export function WidgetsPanel({ project, update, data, fonts, onFonts, selection, onSelect, focusFont, onFocused }: Props) {
  const [adding, setAdding] = useState(false), [position, setPosition] = useState<React.CSSProperties>({});
  const fontField = useRef<HTMLLabelElement>(null), addButton = useRef<HTMLButtonElement>(null), picker = useRef<HTMLDivElement>(null);
  const key = selection[selection.length - 1], widget = project.widgets.find(item => item.key === key);
  useEffect(() => {
    if (!focusFont || focusFont !== key) return;
    fontField.current?.querySelector<HTMLButtonElement>('[role=combobox]')?.focus();
    fontField.current?.scrollIntoView({ block: 'center' }); onFocused();
  }, [focusFont, key]);
  // 浮层挂在 body 上：检查器每块都有入场动画、各自是层叠上下文，放在块里会被后面的属性块盖住。
  // 位置按“添加组件”按钮计算，下方放不下就向上展开；与下拉框的做法一致。
  useLayoutEffect(() => {
    if (!adding) return;
    const rect = addButton.current!.getBoundingClientRect(), below = innerHeight - rect.bottom - 12, above = rect.top - 12;
    const downward = below >= Math.min(440, above), width = Math.max(rect.width, 296);
    setPosition({ position: 'fixed', left: Math.min(Math.max(10, rect.left + rect.width / 2 - width / 2), innerWidth - width - 10), width,
      ...(downward ? { top: rect.bottom + 6 } : { bottom: innerHeight - rect.top + 6 }), maxHeight: Math.max(160, Math.min(520, downward ? below : above)) });
    const close = (event: PointerEvent) => { if (!picker.current?.contains(event.target as Node) && !addButton.current?.contains(event.target as Node)) setAdding(false); };
    // Esc 先收起浮层；捕获阶段处理并标记，编辑器就不会跟着关闭。
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setAdding(false); } };
    const resize = () => setAdding(false);
    document.addEventListener('pointerdown', close); document.addEventListener('keydown', escape, true); addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', escape, true); removeEventListener('resize', resize); };
  }, [adding]);
  const change = (patch: Partial<Widget>, history?: string) => update(p => { const item = p.widgets.find(entry => entry.key === key); if (item) Object.assign(item, patch); }, history);
  const add = (target: WidgetKey) => {
    if (!project.widgets.some(item => item.key === target)) update(p => { p.widgets.push(model.widget(target)); p.showWidgets = true; });
    onSelect([target]); setAdding(false);
  };
  const remove = (target: WidgetKey) => { update(p => { p.widgets = p.widgets.filter(item => item.key !== target); }); onSelect(selection.filter(item => item !== target)); };
  /** 打开组件时没有壁纸字体，给时间、日期、星期挑一款本机常见字体 */
  async function toggle(on: boolean) {
    let initial = '';
    if (on && !data.detail.fontIssue && !data.detail.fonts.length) {
      const available = fonts.length ? fonts : await window.yingchuang.fonts();
      const regular = available.filter(f => !/Bold|Black|Italic|Heavy|粗|斜/i.test(f.label));
      for (const pattern of [/MiSans/i, /Microsoft YaHei|微软雅黑/i, /Noto Sans CJK|思源黑体/i, /DejaVu Sans$/i]) { initial = regular.find(f => pattern.test(f.label))?.value || ''; if (initial) break; }
      initial ||= regular[0]?.value || available[0]?.value || '';
    }
    update(p => { p.showWidgets = on; if (initial) for (const item of p.widgets) if (widgetSpec(item.key).core && !item.font) item.font = initial; });
  }
  const spec = widget ? widgetSpec(widget.key) : null, core = Boolean(spec?.core);
  const timeColor = project.widgets.find(item => item.key === 'time')?.color;
  const sourceNote = spec ? definitions.sources[spec.category as keyof typeof definitions.sources]?.note : undefined;
  return <>
    <div className="inspector-section"><Toggle label="显示组件" checked={project.showWidgets} onChange={v => void toggle(v)}/>
      <div className={`widget-list ${project.showWidgets ? '' : 'muted'}`}>
        {project.widgets.map(item => { const Icon = widgetIcons[item.key]; return <div key={item.key} className={`widget-row ${selection.includes(item.key) ? 'selected' : ''}`}>
          <button className="widget-row-main" onClick={event => onSelect(event.shiftKey ? (selection.includes(item.key) ? selection.filter(k => k !== item.key) : [...selection, item.key]) : [item.key])}><Icon size={15}/><span>{widgetSpec(item.key).name}</span></button>
          <button className="icon-button" aria-label={`移除${widgetSpec(item.key).name}`} title="移除" onClick={() => remove(item.key)}><X size={14}/></button></div>; })}
        <div className="widget-add-anchor">
          <button ref={addButton} className="text-button widget-add" aria-expanded={adding} onClick={() => setAdding(!adding)}><Plus size={14}/>添加组件</button>
          {adding && createPortal(<div ref={picker} className="select-popup widget-picker" style={position} role="dialog" aria-label="添加组件">{definitions.categories.map(category => <div className="widget-category" key={category.key}><h3>{category.name}</h3>
            <div className="widget-grid">{definitions.widgets.filter(item => item.category === category.key).map(item => { const added = project.widgets.some(entry => entry.key === item.key), Icon = widgetIcons[item.key as WidgetKey];
              return <button key={item.key} className={`widget-card ${added ? 'is-visible' : ''}`} onClick={() => add(item.key as WidgetKey)}><Icon size={15}/><span>{item.name}</span>{added && <Check size={11}/>}</button>; })}</div></div>)}</div>, document.body)}
        </div>
      </div>
    </div>
    {widget && spec && <div className="inspector-section widget-settings"><div className="section-title">{spec.name}</div>
      <div className="two-fields"><label>横向位置<input aria-label={`${spec.name}横向位置`} type="number" min={0} max={100} step={.1} value={Number((widget.x * 100).toFixed(1))} onChange={e => change({ x: Number(e.target.value) / 100 }, 'widget-x')}/></label>
        <label>纵向位置<input aria-label={`${spec.name}纵向位置`} type="number" min={0} max={100} step={.1} value={Number((widget.y * 100).toFixed(1))} onChange={e => change({ y: Number(e.target.value) / 100 }, 'widget-y')}/></label></div>
      <label ref={fontField} className="stack-field"><span>字体</span><Select aria-label={`${spec.name}字体`} value={widget.font} onChange={async e => {
        const value = e.target.value;
        if (value === '__file') { const file = await window.yingchuang.chooseFile('font'); if (file) { onFonts([{ value: file, label: file.split(/[\\/]/).pop() || file }, ...fonts]); change({ font: file }); } }
        else change({ font: value });
      }}><option value="">{core ? '壁纸原字体' : '跟随时间字体'}</option>{data.detail.fonts.length > 0 && <optgroup label="壁纸内置字体">{data.detail.fonts.map((f, i) => <option key={i} value={f.value}>{f.label}</option>)}</optgroup>}
        <optgroup label="本机字体">{fonts.map((f, i) => <option key={i} value={f.value}>{f.label}</option>)}</optgroup><option value="__file">选择字体文件…</option></Select></label>
      <Slider label="字号" value={widget.size} min={10} max={180} onChange={v => change({ size: v }, 'widget-size')}/>
      <div className="color-field"><span>颜色</span><div className="color-controls"><ColorWell label={`${spec.name}颜色`} value={widget.color || (core ? data.detail.sourceColors?.[widget.key] : timeColor || data.detail.sourceColors?.time) || '#ffffff'} onChange={value => change({ color: value }, 'widget-color')}/>
        <ResetButton label={core ? '使用壁纸原颜色' : '跟随时间颜色'} onClick={() => change({ color: '' })}/></div></div>
      <div className="alignment-field"><span>文字效果</span><Segmented glass={false} label={`${spec.name}文字效果`} value={widget.effect} onChange={effect => change({ effect })}
        options={[{ value: 'none', label: '无' }, { value: 'shadow', label: '阴影' }, { value: 'outline', label: '描边' }]}/></div>
      <div className="alignment-field"><span>对齐</span><Segmented glass={false} label={`${spec.name}对齐`} value={widget.align} onChange={align => change({ align })}
        options={([['left', AlignLeft, '左对齐'], ['center', AlignCenter, '居中'], ['right', AlignRight, '右对齐']] as const).map(([value, Icon, title]) => ({ value, label: '', icon: <Icon size={15} aria-label={`${spec.name}${title}`}/>, title }))}/></div>
      {'format' in spec && <Toggle label="显示单位与标签" checked={widget.label} onChange={v => change({ label: v })}/>}
      {widget.key === 'text' && <label className="stack-field"><span>自定义文字</span><input aria-label="自定义文字" maxLength={40} value={widget.text ?? ''} onChange={e => change({ text: [...e.target.value].slice(0, 40).join('') }, 'widget-text')}/></label>}
      {'lang' in spec && spec.lang && <label className="stack-field"><span>语言</span><Select aria-label={`${spec.name}语言`} value={widget.language} onChange={e => change({ language: e.target.value as 'zh' | 'en' })}><option value="zh">中文</option><option value="en">英文</option></Select></label>}
      {widget.key === 'time' && <><label className="stack-field"><span>时间格式</span><Select aria-label="时间格式" value={widget.hourFormat ?? 'auto'} onChange={e => change({ hourFormat: e.target.value as Widget['hourFormat'] })}><option value="auto">跟随壁纸</option><option value="24">24 小时</option><option value="12">12 小时</option></Select></label>
        <Toggle label="显示秒数" checked={widget.seconds === true} onChange={v => change({ seconds: v })}/></>}
      {sourceNote && <div className="hint widget-source"><Info size={13}/>{sourceNote}</div>}
    </div>}
  </>;
}
