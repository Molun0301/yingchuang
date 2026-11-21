// 界面使用的作品模型：与主进程共用 desktop/project.cjs，组件定义在构建时打包。
import definitions from '../../core/组件.json';
import projectModule from '../../desktop/project.cjs';
import type { Project, Template, Widget, WidgetKey } from '../types';

type ProjectModel = {
  KEYS: WidgetKey[];
  widget(key: WidgetKey, input?: Partial<Widget>): Widget;
  normalize(input: unknown): Project;
  applyTemplate(project: Project, template: Template): Project;
  templateLayout(project: Project): Template['layout'];
  glyphSignature(project: Project): string;
};
export const model: ProjectModel = projectModule.createProjectModel(definitions);
export { definitions };
export const widgetSpec = (key: WidgetKey) => definitions.widgets.find(widget => widget.key === key)!;
