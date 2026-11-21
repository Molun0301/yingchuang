// 作品数据模型（v2）：主进程与界面共用的纯函数，不依赖 Node 模块。
// 组件定义（core/组件.json）由调用方传入：打包后 core 不在 app.asar 里，界面则在构建时打包这份 JSON。
'use strict';

const EFFECTS = ['none', 'shadow', 'outline'];
const ALIGNS = ['left', 'center', 'right'];
const HOUR_FORMATS = ['auto', '24', '12'];
const QUALITIES = ['compact', 'standard', 'high'];
const DEFAULT_FRAMING = { scale: 1.06, x: 0.5, y: 0.5, flip: false };
const DEFAULT_MOTION = { amount: 0.02, sensitivity: 4, smoothing: 0.16, vertical: 0.3, fps: 30 };
// mode：layers 图层模式、record 录制模式；duration、fps、loop、fade 只用于录制模式。
const DEFAULT_EXPORT = { mode: 'layers', quality: 'standard', timeVariation: false, duration: 10, fps: 30, loop: true, fade: 0.6 };

const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const bounded = (value, fallback, min, max) => Math.max(min, Math.min(max, finite(value, fallback)));
const clone = value => JSON.parse(JSON.stringify(value));
const pick = (value, options, fallback) => options.includes(value) ? value : fallback;
const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

function createProjectModel(definitions) {
  const specs = definitions.widgets;
  const KEYS = specs.map(spec => spec.key);
  const specOf = key => specs.find(spec => spec.key === key);

  /** 一个组件的完整设置；input 缺的字段取组件定义的默认值 */
  function widget(key, input = {}) {
    const spec = specOf(key);
    const item = {
      key,
      x: bounded(input.x, spec.x, 0, 1),
      y: bounded(input.y, spec.y, 0, 1),
      size: bounded(input.size, spec.size, 10, 180),
      align: pick(input.align, ALIGNS, spec.align),
      // 字体、颜色留空：时间、日期、星期沿用壁纸原有的，其余组件跟随时间组件。
      font: typeof input.font === 'string' ? input.font : '',
      color: typeof input.color === 'string' ? input.color : '',
      effect: pick(input.effect, EFFECTS, 'none'),
      language: pick(input.language, ['zh', 'en'], key === 'week' ? 'en' : 'zh'),
      label: input.label !== false,
    };
    if (key === 'text') item.text = [...String(input.text ?? spec.sample)].slice(0, 40).join('');
    if (key === 'time') {
      item.hourFormat = pick(input.hourFormat, HOUR_FORMATS, 'auto');
      item.seconds = input.seconds === true;
    }
    return item;
  }

  function exportSettings(input = {}) {
    const value = { ...DEFAULT_EXPORT, ...plainObject(input) };
    return {
      mode: value.mode === 'record' ? 'record' : 'layers',
      quality: pick(value.quality, QUALITIES, 'standard'),
      timeVariation: value.timeVariation === true,
      duration: bounded(value.duration, 10, 2, 30),
      fps: [24, 30, 60].includes(Number(value.fps)) ? Number(value.fps) : 30,
      loop: value.loop !== false,
      fade: bounded(value.fade, 0.6, 0.1, 2),
    };
  }

  /** 清洗成合法的 v2 作品：数值限幅、未知组件丢弃、同一种组件只保留第一个 */
  function normalize(input = {}) {
    const framing = plainObject(input.framing), motion = plainObject(input.motion), seen = new Set();
    const widgets = [];
    for (const item of Array.isArray(input.widgets) ? input.widgets : []) {
      if (!item || !KEYS.includes(item.key) || seen.has(item.key)) continue;
      seen.add(item.key); widgets.push(widget(item.key, item));
    }
    return {
      version: 2,
      framing: { scale: bounded(framing.scale, DEFAULT_FRAMING.scale, 0.2, 5), x: bounded(framing.x, 0.5, 0, 1),
        y: bounded(framing.y, 0.5, 0, 1), flip: framing.flip === true },
      showWidgets: input.showWidgets !== false,
      widgets,
      motion: { amount: bounded(motion.amount, DEFAULT_MOTION.amount, 0, 0.1), sensitivity: finite(motion.sensitivity, DEFAULT_MOTION.sensitivity),
        smoothing: bounded(motion.smoothing, DEFAULT_MOTION.smoothing, 0.02, 1), vertical: bounded(motion.vertical, DEFAULT_MOTION.vertical, 0, 1),
        fps: [15, 24, 30, 60, 120].includes(Number(motion.fps)) ? Number(motion.fps) : DEFAULT_MOTION.fps },
      properties: clone(plainObject(input.properties)),
      layers: clone(plainObject(input.layers)),
      export: exportSettings(input.export),
    };
  }

  /** 新作品：壁纸有自带时钟时默认显示时间、日期、星期，替换原时钟 */
  function create({ properties = {}, hasClock = true } = {}) {
    return normalize({ showWidgets: hasClock, widgets: specs.filter(spec => spec.core).map(spec => widget(spec.key)), properties });
  }

  /**
   * v1 草稿 → v2 作品。v1 把一个组件分在 layout.clock.rows、appearance.fonts、appearance.colors 三处，
   * 时制与秒数在 layout.clock 上，机型 deviceId 在草稿里（v2 改为全局设置，迁移时丢弃）。
   */
  function migrate(draft) {
    if (!draft || draft.version === 2) return normalize(draft || {});
    const layout = plainObject(draft.layout), clock = plainObject(layout.clock), rows = plainObject(clock.rows);
    const fonts = plainObject(draft.appearance?.fonts), colors = plainObject(draft.appearance?.colors);
    const widgets = KEYS.filter(key => rows[key] ? rows[key].visible === true : Boolean(specOf(key).core)).map(key => widget(key, {
      ...rows[key], font: fonts[key], color: colors[key],
      language: rows[key]?.language ?? (key === 'week' ? clock.language : undefined),
      ...(key === 'time' ? { hourFormat: clock.format, seconds: clock.seconds } : {}),
    }));
    return normalize({ framing: layout, showWidgets: clock.enabled !== false, widgets, motion: draft.motion,
      properties: draft.properties, layers: draft.layers, export: draft.export });
  }

  /** 模板只保存取景和组件排版（哪些组件、位置、字号、对齐）；字体、颜色、文字效果、语言和壁纸设置留在各自作品里 */
  function templateLayout(project) {
    const value = normalize(project);
    return { framing: { scale: value.framing.scale, x: value.framing.x, y: value.framing.y }, showWidgets: value.showWidgets,
      widgets: value.widgets.map(({ key, x, y, size, align }) => ({ key, x, y, size, align })) };
  }

  /** 套用模板：组件集合与排版取模板，已有组件保留自己的字体、颜色、效果、语言与文字；翻转保持不变 */
  function applyTemplate(project, template) {
    const value = normalize(project), layout = migrateTemplate(template).layout;
    const widgets = layout.widgets.filter(item => KEYS.includes(item.key)).map(item => {
      const current = value.widgets.find(entry => entry.key === item.key);
      return widget(item.key, { ...current, x: item.x, y: item.y, size: item.size, align: item.align });
    });
    return normalize({ ...value, framing: { ...value.framing, scale: layout.framing.scale, x: layout.framing.x, y: layout.framing.y },
      showWidgets: layout.showWidgets, widgets });
  }

  /** 旧模板（layout.rows 带 visible）→ 新模板（layout.widgets 只列出显示的组件） */
  function migrateTemplate(template) {
    const layout = plainObject(template.layout);
    if (Array.isArray(layout.widgets)) {
      const framing = plainObject(layout.framing);
      return { ...template, layout: { framing: { scale: bounded(framing.scale, 1.06, 0.2, 5), x: bounded(framing.x, 0.5, 0, 1), y: bounded(framing.y, 0.5, 0, 1) },
        showWidgets: layout.showWidgets !== false,
        widgets: layout.widgets.filter(item => KEYS.includes(item?.key)).map(item => { const full = widget(item.key, item); return { key: full.key, x: full.x, y: full.y, size: full.size, align: full.align }; }) } };
    }
    const rows = plainObject(layout.rows);
    const widgets = KEYS.filter(key => rows[key] ? rows[key].visible === true : false).map(key => {
      const full = widget(key, rows[key]); return { key, x: full.x, y: full.y, size: full.size, align: full.align };
    });
    return { ...template, layout: { framing: { scale: bounded(layout.scale, 1.06, 0.2, 5), x: bounded(layout.x, 0.5, 0, 1), y: bounded(layout.y, 0.5, 0, 1) },
      showWidgets: layout.clockEnabled !== false, widgets } };
  }

  function builtinTemplates() {
    const at = (key, x, y, size, align) => ({ key, x, y, size, align });
    const framing = { scale: DEFAULT_FRAMING.scale, x: DEFAULT_FRAMING.x, y: DEFAULT_FRAMING.y };
    return [
      { id: 'builtin-classic', name: '经典三行', builtin: true, layout: { framing, showWidgets: true,
        widgets: specs.filter(spec => spec.core).map(spec => at(spec.key, spec.x, spec.y, spec.size, spec.align)) } },
      { id: 'builtin-corner', name: '角落时光', builtin: true, layout: { framing, showWidgets: true,
        widgets: [at('date', 0.94, 0.77, 25, 'right'), at('time', 0.94, 0.89, 54, 'right')] } },
      { id: 'builtin-minimal', name: '留白', builtin: true, layout: { framing, showWidgets: true, widgets: [at('time', 0.75, 0.5, 86, 'center')] } },
    ];
  }

  /** 需要转换核心重新生成组件字形的字段；位置与对齐只在画布上移动，不在其中 */
  function glyphSignature(project) {
    const value = normalize(project);
    return JSON.stringify([value.showWidgets, value.widgets.map(item => [item.key, item.size, item.font, item.color, item.effect, item.language,
      item.label, item.text ?? null, item.hourFormat ?? null, item.seconds ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
  }

  return { KEYS, EFFECTS, DEFAULT_EXPORT, DEFAULT_MOTION, DEFAULT_FRAMING, specOf, widget, exportSettings, normalize, create, migrate,
    templateLayout, applyTemplate, migrateTemplate, builtinTemplates, glyphSignature };
}

module.exports = { createProjectModel };
