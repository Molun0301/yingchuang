const { randomUUID } = require('node:crypto');

const ROWS = ['week', 'date', 'time'];
const DEFAULT_LAYOUT = {
  scale: 1.06, x: 0.5, y: 0.5,
  clock: { enabled: true, language: 'en', format: 'auto', seconds: false,
    rows: {
      week: { visible: true, x: 0.74, y: 0.36, size: 43, align: 'center' },
      date: { visible: true, x: 0.74, y: 0.47, size: 34, align: 'center' },
      time: { visible: true, x: 0.74, y: 0.62, size: 69, align: 'center' },
    } },
};
const clone = value => structuredClone(value);
// 导出方式：layers 图层模式（默认）、record 录制模式；后几项是录制时长（秒）、帧率、首尾交叉淡化（秒）。
const DEFAULT_EXPORT = { mode: 'layers', duration: 10, fps: 30, loop: true, fade: 0.6, quality: 'standard' };
function exportSettings(draft) {
  const input = { ...DEFAULT_EXPORT, ...draft?.export };
  return { mode: input.mode === 'record' ? 'record' : 'layers', duration: bounded(input.duration, 10, 2, 30),
    fps: [24, 30, 60].includes(Number(input.fps)) ? Number(input.fps) : 30, loop: input.loop !== false, fade: bounded(input.fade, 0.6, 0.1, 2),
    quality: ['compact', 'high'].includes(input.quality) ? input.quality : 'standard' };
}
const finite = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const bounded = (value, fallback, min, max) => Math.max(min, Math.min(max, finite(value, fallback)));

function cleanLayout(input = {}) {
  const layout = clone(DEFAULT_LAYOUT);
  layout.scale = bounded(input.scale, layout.scale, 0.2, 5);
  layout.x = bounded(input.x, layout.x, 0, 1);
  layout.y = bounded(input.y, layout.y, 0, 1);
  const clock = input.clock || {};
  if (typeof clock.enabled === 'boolean') layout.clock.enabled = clock.enabled;
  if (['en', 'zh'].includes(clock.language)) layout.clock.language = clock.language;
  if (['auto', '24', '12'].includes(clock.format)) layout.clock.format = clock.format;
  if (typeof clock.seconds === 'boolean') layout.clock.seconds = clock.seconds;
  for (const key of ROWS) {
    const row = clock.rows?.[key] || {};
    const target = layout.clock.rows[key];
    target.x = bounded(row.x, target.x, 0, 1);
    target.y = bounded(row.y, target.y, 0, 1);
    target.size = bounded(row.size, target.size, 10, 180);
    if (typeof row.visible === 'boolean') target.visible = row.visible;
    if (['left', 'center', 'right'].includes(row.align)) target.align = row.align;
  }
  return layout;
}

function templateLayout(layout) {
  // 模板只携带排版；语言、时间格式和主题内容仍各自保留。
  const normalized = cleanLayout(layout);
  const rows = Object.fromEntries(ROWS.map(key => [key, { ...normalized.clock.rows[key] }]));
  return { scale: normalized.scale, x: normalized.x, y: normalized.y, clockEnabled:normalized.clock.enabled, rows };
}

function applyTemplate(draft, template) {
  const result = clone(draft);
  const input = template.layout || template;
  result.layout = cleanLayout({ ...draft.layout, scale: input.scale, x: input.x, y: input.y,
    clock: { ...draft.layout.clock, enabled:input.clockEnabled??draft.layout.clock.enabled, rows: input.rows } });
  return result;
}

function makeTemplate(name, layout) {
  return { id: randomUUID(), name: String(name).trim().slice(0, 40) || '新排版',
    layout: templateLayout(layout), createdAt: Date.now() };
}

function defaultDraft(properties = {}, hasClock = true, deviceId = 'xiaomi-18-pro-max') {
  const layout = clone(DEFAULT_LAYOUT);
  layout.clock.enabled = hasClock;
  return { version: 1, deviceId, layout,
    appearance: { fonts: { week: '', date: '', time: '' }, colors: { week: '', date: '', time: '' } },
    motion: { amount: 0.02, sensitivity: 4, smoothing: 0.16, vertical: 0.3, fps: 30 },
    export: { ...DEFAULT_EXPORT }, properties: clone(properties), layers: {} };
}

function builtinTemplates() {
  const centered = clone(DEFAULT_LAYOUT);
  for (const row of Object.values(centered.clock.rows)) row.x = 0.68;
  const bottom = clone(DEFAULT_LAYOUT);
  bottom.clock.rows.week = { visible: false, x: 0.96, y: 0.55, size: 30, align: 'right' };
  bottom.clock.rows.date = { visible: true, x: 0.94, y: 0.77, size: 25, align: 'right' };
  bottom.clock.rows.time = { visible: true, x: 0.94, y: 0.89, size: 54, align: 'right' };
  const calm = clone(DEFAULT_LAYOUT);
  calm.clock.rows.week.visible = false;
  calm.clock.rows.date.visible = false;
  calm.clock.rows.time = { visible: true, x: 0.75, y: 0.5, size: 86, align: 'center' };
  return [
    { id: 'builtin-classic', name: '经典三行', layout: templateLayout(DEFAULT_LAYOUT), builtin: true },
    { id: 'builtin-corner', name: '角落时光', layout: templateLayout(bottom), builtin: true },
    { id: 'builtin-minimal', name: '留白', layout: templateLayout(calm), builtin: true },
  ];
}

module.exports = { ROWS, DEFAULT_LAYOUT, DEFAULT_EXPORT, exportSettings, cleanLayout, templateLayout, applyTemplate, makeTemplate, defaultDraft, builtinTemplates };
