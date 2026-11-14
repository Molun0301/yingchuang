// 背屏组件的排布计算：编辑器画布与导出包的交互预览共用，Python 静态预览与背屏清单按同一算法实现。
(function (root) {
  /** 农历月序（含闰月，0 起）与日序（0 起），与背屏的 #month_lunar、#date_lunar 对应 */
  function lunar(date) {
    const parts = new Intl.DateTimeFormat('zh-CN-u-ca-chinese', { month: 'numeric', day: 'numeric' }).formatToParts(date);
    const month = parts.find(p => p.type === 'month').value, day = Number(parts.find(p => p.type === 'day').value);
    const leap = /闰|bis/.test(month) ? 1 : 0;
    return { lm: Number(month.replace(/\D/g, '')) - 1 + 12 * leap, ld: day - 1 };
  }

  /** 当前时刻的时钟字段与示例数据；samples 为字段名到示例值，lunar 可由调用方给出 */
  function values(date, samples, given = lunar(date)) {
    const result = { Y: date.getFullYear(), M: date.getMonth() + 1, D: date.getDate(), h: date.getHours(), m: date.getMinutes(), s: date.getSeconds(), w: date.getDay() };
    Object.assign(result, samples, given);
    return result;
  }

  function digitFile(row, value) { return row.digits[value]; }

  /** 按行语言显示组件示例，与字形生成使用同一份格式和字段选项。 */
  function widgetText(definitions, key, row, v) {
    const spec = definitions.widgets.find(widget => widget.key === key);
    if (key === 'week') return row.language === 'zh' ? '星期' + '日一二三四五六'[v.w]
      : ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'][v.w];
    if (key === 'text') return row.text ?? spec.sample;
    if (spec.core) return spec.sample;
    const mode = row.label === false ? 'bare' : 'format';
    const english = spec.lang && row.language === 'en';
    return spec[english ? mode + '_en' : mode].replace(/\{(\w+)(?:\.(\d))?(?::(\d))?\}/g, (_, key, dec, pad) => {
      const field = definitions.fields[key], raw = v[key];
      if (field.choices) {
        const choices = field[english ? 'choices_en' : 'choices'];
        return choices[Math.max(0, Math.min(choices.length - 1, Math.floor(raw)))];
      }
      const scale = 10 ** Number(dec || 0), units = Math.floor(Math.abs(raw) * scale + 0.5);
      return (field.neg && raw < 0 ? '-' : '') + String(Math.floor(units / scale)).padStart(Number(pad || 1), '0')
        + (dec ? '.' + String(units % scale).padStart(Number(dec), '0') : '');
    });
  }

  /**
   * 计算一行组件的图片排布。返回总宽 w 与各片段 {file,x,w}，x 为片段中心相对整行中心的偏移；
   * 单位为字形像素，调用方再乘以缩放。
   */
  function rowParts(row, v) {
    if (row.weekdays) return { w: row.w, parts: [{ file: row.weekdays[v.w], x: 0, w: row.w }] };
    if (!row.segments) {
      const hour = row.hourFormat === '12' ? (v.h % 12 || 12) : v.h;
      const fields = { ...v, h: hour };
      return { w: row.w, parts: row.pieces.map(part => ({
        file: part.asset || row.digits[Math.floor(fields[part.digit[0]] / (10 ** Number(part.digit[1]))) % 10], x: part.x, w: part.w })) };
    }
    const parts = [];
    let x = 0;
    const put = (file, w) => { parts.push({ file, x: x + w / 2, w }); x += w; };
    for (const seg of row.segments) {
      if (seg.t === 's') put(seg.asset, seg.w);
      else if (seg.t === 'c') {
        const index = Math.max(0, Math.min(seg.assets.length - 1, Math.floor(v[seg.f])));
        put(seg.assets[index], seg.ws[index]);
      } else if (seg.t === 'n') {
        const raw = v[seg.f], scale = 10 ** seg.dec;
        const units = Math.floor(Math.abs(raw) * scale + 0.5), whole = Math.floor(units / scale);
        if (seg.neg && raw < 0) put(row.minus.asset, row.minus.w);
        const text = String(whole).padStart(seg.pad, '0');
        for (const ch of text) put(digitFile(row, Number(ch)), row.digitW);
        if (seg.dec) {
          put(row.dot.asset, row.dot.w);
          const fraction = String(units % scale).padStart(seg.dec, '0');
          for (const ch of fraction) put(digitFile(row, Number(ch)), row.digitW);
        }
      }
    }
    for (const part of parts) part.x -= x / 2;
    return { w: x, parts };
  }

  const api = { lunar, values, rowParts, widgetText };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.YingchuangWidgets = api;
})(globalThis);
