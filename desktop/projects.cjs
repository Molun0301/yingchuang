const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const { createProjectModel } = require('./project.cjs');

const model = createProjectModel(require(process.versions.electron && !process.defaultApp
  ? path.join(process.resourcesPath,'core','组件.json') : path.join(__dirname,'../core','组件.json')));

function migrateStorage(data) {
  const { drafts, ...saved } = data;
  return { ...saved, version: 2,
    projects: Object.fromEntries(Object.entries(drafts || {}).map(([id,draft])=>[id,model.migrate(draft)])),
    templates: (saved.templates || []).map(model.migrateTemplate) };
}

function propertyDifferences(properties, defaults) {
  return Object.fromEntries(Object.entries(properties).filter(([key,value])=>!isDeepStrictEqual(value,defaults[key])));
}

class Projects {
  constructor(store, inspect, runWorker) {
    this.store=store;this.inspect=inspect;this.runWorker=runWorker;
  }
  async forTheme(theme) {
    const saved=this.store.data.projects[theme.id];
    if(saved)return model.normalize({...saved,properties:{...theme.propertyValues,...saved.properties}});
    return model.create({properties:theme.propertyValues,hasClock:(await this.inspect(theme)).hasClock});
  }
  write(theme, project) {
    const saved=model.normalize(project);
    saved.properties=propertyDifferences(saved.properties,theme.propertyValues);
    this.store.data.projects[theme.id]=saved;
  }
  save(theme, project) { this.write(theme,project);this.store.save(); }
  fonts() { return this.systemFonts ||= this.runWorker({operation:'fonts'}); }

  async ensureClockFont(theme,project) {
    const rows=project.widgets.filter(widget=>['week','date','time'].includes(widget.key)&&!widget.font);
    if(!project.showWidgets||!rows.length)return project;
    const detail=await this.inspect(theme);
    if(detail.fontIssue||Object.keys(detail.sourceFonts||{}).length)return project;
    const available=await this.fonts();
    const regular=available.filter(f=>!/Bold|Black|Italic|Heavy|粗|斜/i.test(f.label));
    let chosen;
    for(const pattern of [/MiSans/i,/Microsoft YaHei|微软雅黑/i,/Noto Sans CJK|思源黑体/i,/DejaVu Sans$/i]){chosen=regular.find(f=>pattern.test(f.label));if(chosen)break;}
    chosen ||= regular[0]||available[0];
    if(chosen)for(const widget of rows)widget.font=chosen.value;
    return project;
  }

  saveTemplate(name, project) {
    return this.store.update(data=>data.templates.push({id:randomUUID(),name:templateName(name),
      layout:model.templateLayout(project),createdAt:Date.now()}));
  }
  renameTemplate(id, name) {
    return this.store.update(data=>{
      const template=data.templates.find(item=>item.id===id);
      if(template)template.name=templateName(name);
    });
  }
  deleteTemplate(id) {
    return this.store.update(data=>{data.templates=data.templates.filter(item=>item.id!==id);});
  }
  async applyTemplate(themes, id) {
    const template=this.store.snapshot().templates.find(item=>item.id===id);
    if(!template)throw new Error('排版模板不存在。');
    const applied=[];
    for(const theme of themes)applied.push([theme,model.applyTemplate(await this.forTheme(theme),template)]);
    for(const [theme,project] of applied)this.write(theme,project);
    this.store.save();
  }
}
function templateName(name) { return String(name).trim().slice(0,40)||'新排版'; }
module.exports = { Projects, model, migrateStorage, propertyDifferences };
