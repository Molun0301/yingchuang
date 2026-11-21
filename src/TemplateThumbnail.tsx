// 排版模板缩略图：用组件示例文字示意模板里各组件的位置、字号与对齐。
import type { Template } from './types';
import definitions from '../core/组件.json';
import widgets from '../core/组件绘制.cjs';

const samples = { ...Object.fromEntries(Object.entries(definitions.fields).filter(([, field]) => 'sample' in field).map(([key, field]) => [key, (field as { sample: number }).sample])), lm: 9, ld: 23, w: 5 };

export function TemplateThumbnail({ template, compact = false }: { template: Template; compact?: boolean }) {
  return <div className={`template-thumbnail ${compact ? 'compact' : ''}`}><div className="template-phone"><div className="template-camera"><i/><i/></div>
    {template.layout.showWidgets && template.layout.widgets.map(item => <span key={item.key} style={{ left: `${item.x * 100}%`, top: `${item.y * 100}%`, fontSize: `${item.size / (compact ? 9.5 : 6.2)}px`,
      transform: `translate(${item.align === 'center' ? '-50%' : item.align === 'right' ? '-100%' : '0'},-50%)` }}>{widgets.widgetText(definitions, item.key, { language: item.key === 'week' ? 'en' : 'zh', label: true }, samples)}</span>)}
  </div></div>;
}
