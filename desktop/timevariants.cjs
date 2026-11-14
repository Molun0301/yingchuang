// 按时间导出：渲染器在一天中固定的 8 个时刻（及 QuickJS 发现的跳变时刻）观察完整壁纸，QuickJS 在相邻采样之间按分钟定位切换。
const DAY = 1440;
// 避开作者常用的整点切换，每 3 小时一个时刻。
const POINTS = [90, 270, 450, 630, 810, 990, 1170, 1350];
const TOLERANCE = { origin: .5, scale: .004, alpha: .004, color: .004, brightness: .004, angles: .001 };
const FIELDS = ['visible', 'effective', 'alpha', 'color', 'origin', 'scale', 'angles', 'brightness'];
const CURVE_FIELDS = ['visible', 'effective', 'alpha', 'origin', 'scale', 'angles'];
const wrap = minute => ((minute % DAY) + DAY) % DAY;

/** 渲染器看得到的字段优先；其余文字、材质参数等保留 QuickJS 求值结果。 */
function observationScene(scene, snapshot) {
  const result = structuredClone(scene), layers = new Map(snapshot.layers.map(layer => [layer.id, layer]));
  for (const object of result.objects) {
    const layer = layers.get(object.id);
    if (!layer) continue;
    for (const key of FIELDS) if (key !== 'effective') object[key] = Array.isArray(layer[key]) ? layer[key].join(' ') : layer[key];
  }
  return result;
}

/** 签名只给渲染器字段容差，QuickJS 其余字段保持精确比较。 */
function same(a, b, key = '', rendered = false) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return rendered && Math.abs(a - b) <= TOLERANCE[key];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every(field => same(a[field], b[field], Array.isArray(a) ? key : field, rendered || field === 'render'));
}

/** 每层的状态：自身、上级，以及绘制顺序在它之上的调色层；任一时刻不稳定的字段不参与比较。 */
function signatures(samples, exclude, adjustLayerIds) {
  const unstable = new Map();
  for (const { snapshot } of samples) for (const [id, fields] of Object.entries(snapshot.unstable))
    unstable.set(Number(id), new Set([...(unstable.get(Number(id)) || []), ...fields]));
  return samples.map(({ scene, snapshot }) => {
    const byId = new Map(scene.objects.map(object => [object.id, object]));
    const layers = new Map(snapshot.layers.map(layer => [layer.id, layer]));
    const node = id => {
      const object = byId.get(id), layer = layers.get(id), ignored = unstable.get(id) || new Set();
      return { id, render: Object.fromEntries(FIELDS.filter(key => !ignored.has(key) && layer).map(key => [key, layer[key]])),
        rest: Object.fromEntries(Object.entries(object).filter(([key]) => (!layer || !FIELDS.includes(key)) && !ignored.has(key))) };
    };
    const parents = id => {
      const result = [];
      for (let object = byId.get(byId.get(id)?.parent); object; object = byId.get(object.parent)) result.push(node(object.id));
      return result;
    };
    const result = new Map();
    for (let i = 0; i < scene.objects.length; i++) {
      const object = scene.objects[i];
      if (exclude.has(object.id)) continue;
      const adjust = scene.objects.slice(i + 1).filter(above => adjustLayerIds.has(above.id)).map(above => ({ self: node(above.id), parents: parents(above.id) }));
      result.set(object.id, { self: node(object.id), parents: parents(object.id), adjust });
    }
    return result;
  });
}

/** 循环序列的连续段，起点对齐到状态变化处。 */
function cyclicRuns(states) {
  const n = states.length;
  let offset = states.findIndex((state, i) => state !== states[(i - 1 + n) % n]);
  if (offset < 0) return [{ state: states[0], start: 0, length: n }];
  const runs = [];
  for (let k = 0; k < n; k++) {
    const i = (offset + k) % n;
    if (runs.length && runs[runs.length - 1].state === states[i]) runs[runs.length - 1].length++;
    else runs.push({ state: states[i], start: i, length: 1 });
  }
  return runs;
}

/** 上层渐入/渐出，下层在叠加期间保持不透明，让最终画面等于两种状态的线性混合。 */
function runWeight(run, minute) {
  const rel = wrap(minute - run.a0), A1 = wrap(run.a1 - run.a0), B0 = wrap(run.b0 - run.a0), B1 = wrap(run.b1 - run.a0) || DAY;
  if (rel < A1) return run.enterOnTop ? rel / A1 : 1;
  if (rel < B0) return 1;
  if (rel <= B1) return run.exitUnder ? 1 : B1 === B0 ? 0 : 1 - (rel - B0) / (B1 - B0);
  return 0;
}

/** 权重折点保留切换前后两侧，硬切换不会被拉成渐变。 */
function keypoints(weight, breaks) {
  const minutes = [...new Set([0, .01, DAY - .01, DAY, ...breaks.flatMap(m => [m - .01, m, m + .01]).map(m => Math.min(DAY, Math.max(0, m)))])].sort((a, b) => a - b);
  const points = minutes.map(m => [Math.round(m * 100) / 100, Math.round(weight(m === DAY ? DAY - 1e-6 : m) * 1000) / 1000]);
  const kept = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = kept[kept.length - 1], [x, y] = points[i], [x1, y1] = points[i + 1];
    if (breaks.includes(x) || Math.abs(y0 + (y1 - y0) * (x - x0) / (x1 - x0 || 1) - y) > 1e-4) kept.push(points[i]);
  }
  kept.push(points[points.length - 1]);
  return kept;
}

const interpolate = (a, b, t) => {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (Array.isArray(a)) return a.map((value, i) => interpolate(value, b[i], t));
  return t < .5 ? a : b;
};

function opacity(state) {
  return [state.self, ...state.parents].some(node => node.render.visible === false || node.render.effective === false) ? 0 : (state.self.render.alpha ?? 1);
}
function strip(state, own, parent) {
  const remove = (node, fields) => ({ ...node, render: Object.fromEntries(Object.entries(node.render).filter(([key]) => !fields.includes(key))) });
  return { ...state, self: remove(state.self, own), parents: state.parents.map(node => remove(node, parent)) };
}
const curveBase = state => strip(state, CURVE_FIELDS, ['visible', 'effective', 'alpha']);
const visibilityBase = state => strip(state, ['visible', 'effective'], ['visible', 'effective']);

/** 两个状态之间变了的值里是否有文字、资源名等不能插值的内容；文字字段即使是数字也不能靠两张画面渐变得到。 */
function nonInterpolable(a, b, text = false) {
  if (same(a, b)) return false;
  const numeric = value => typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' &&
    value.trim().split(/\s+/).every(part => part !== '' && !Number.isNaN(Number(part)));
  if (a && b && typeof a === 'object' && typeof b === 'object')
    return [...new Set([...Object.keys(a), ...Object.keys(b)])].some(key => nonInterpolable(a[key], b[key], text || key === 'text'));
  return text || !(numeric(a) && numeric(b));
}

/**
 * 相邻观察时刻 a、b 之间的切换：QuickJS 显示一次跳变 → {w0:w1:该分钟}；多次变化 → 首末变化之间渐变；
 * QuickJS 没有变化 → 只有可见性不同时在中点硬切换，否则整个区间渐变。
 */
async function locate(quick, id, a, b, from, to) {
  const at = async minute => (await quick(minute)).get(id);
  const start = await at(a), end = await at(b);
  if (same(start, end)) {
    if (same(visibilityBase(from), visibilityBase(to))) { const middle = Math.round((a + b) / 2); return { w0: middle, w1: middle, gradual: false }; }
    return { w0: a, w1: b, gradual: true };
  }
  let low = a, high = b;
  while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (same(await at(middle), start)) low = middle; else high = middle; }
  const first = high;
  low = a; high = b;
  while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (same(await at(middle), end)) high = middle; else low = middle; }
  return first === high ? { w0: first, w1: first, gradual: false } : { w0: first - 1, w1: high, gradual: true };
}

/** 区间内 QuickJS 状态跳变的分钟（变化后的第一分钟）；跳变超过 limit 次（如分钟文字、逐分钟渐变）返回 null。 */
async function jumps(quick, id, a, b, limit = 4) {
  const at = async minute => (await quick(minute)).get(id), found = [];
  const walk = async (low, high, from, to) => {
    if (found.length > limit || same(from, to)) return;
    if (high - low === 1) { found.push(high); return; }
    const middle = Math.floor((low + high) / 2), state = await at(middle);
    await walk(low, middle, from, state);
    await walk(middle, high, state, to);
  };
  await walk(a, b, await at(a), await at(b));
  return found.length > limit ? null : found;
}

/** 按各采样时刻的值与相邻采样之间的切换方式生成一天的分段线性关键点。 */
function seriesPoints(values, windows, equal, minutes) {
  const points = [];
  for (let i = 0; i < minutes.length; i++) {
    const value = values[i], next = values[(i + 1) % minutes.length];
    points.push([minutes[i], value]);
    if (equal(value, next)) continue;
    const { w0, w1 } = windows[i];
    points.push(w0 === w1 ? [w0 - .01, value] : [w0, value], [w1, next]);
  }
  points.push([minutes[0] + DAY, values[0]]);
  const valueAt = minute => {
    const m = minute < minutes[0] ? minute + DAY : minute;
    let i = 1;
    while (i < points.length - 1 && points[i][0] < m) i++;
    const [x0, y0] = points[i - 1], [x1, y1] = points[i];
    return x1 === x0 ? y1 : interpolate(y0, y1, (m - x0) / (x1 - x0));
  };
  const breaks = [...new Set([0, DAY, ...points.map(([minute]) => Math.round(wrap(minute) * 100) / 100)])].sort((a, b) => a - b);
  return breaks.map(minute => [minute, valueAt(minute === DAY ? DAY - 1e-6 : minute)]);
}

/** 观察值按段分组为变体，段与段之间按切换方式渐入渐出。 */
function stateVariants(states, windows, minutes) {
  const values = [], indices = states.map(state => {
    let i = values.findIndex(value => same(value, state));
    if (i < 0) { i = values.length; values.push(state); }
    return i;
  });
  const runs = cyclicRuns(indices), variants = [...new Set(runs.map(run => run.state))];
  const edges = runs.map(run => { const { w0, w1 } = windows[(run.start + run.length - 1) % minutes.length]; return [wrap(w0), wrap(w1)]; });
  return variants.map((state, v) => {
    const mine = runs.flatMap((run, i) => {
      if (run.state !== state) return [];
      const before = edges[(i - 1 + runs.length) % runs.length], after = edges[i];
      return [{ a0: before[0], a1: before[1], b0: after[0], b1: after[1],
        enterOnTop: v > variants.indexOf(runs[(i - 1 + runs.length) % runs.length].state), exitUnder: variants.indexOf(runs[(i + 1) % runs.length].state) > v }];
    });
    const longest = runs.filter(run => run.state === state).sort((a, b) => b.length - a.length)[0];
    const minute = minutes[(longest.start + Math.floor((longest.length - 1) / 2)) % minutes.length];
    return { minute, alpha: keypoints(m => variants.length === 1 ? 1 : Math.min(1, mine.reduce((sum, run) => sum + runWeight(run, m), 0)), edges.flat()) };
  });
}

/** 着色器直接读取时刻的图层：8 个时刻各一份画面，相邻时刻之间线性渐变。 */
function blendVariants(minutes) {
  return minutes.map((minute, index) => {
    const previous = (index - 1 + minutes.length) % minutes.length, next = (index + 1) % minutes.length;
    const run = { a0: minutes[previous], a1: minute, b0: minute, b1: minutes[next], enterOnTop: index > previous, exitUnder: next > index };
    return { minute, alpha: keypoints(m => runWeight(run, m), minutes) };
  });
}

/**
 * evaluate(minute) 返回该分钟的 QuickJS 求值场景；observe 接收 next 回调，由录制窗口依次提供 snapshot。
 * 先在固定的 8 个时刻观察；QuickJS 发现某个区间内有几次跳变时（如一天七八种的时段文字），第二天再补看每次跳变后的那一分钟，
 * 让每个中间状态都有渲染画面。返回约定 6 的场景、变体与曲线；没有任何变化时返回 null。
 */
async function planTimeVariants(evaluate, exclude = new Set(), { observe, adjustLayerIds = [], daytimeLayerIds = [] }) {
  const adjust = new Set(adjustLayerIds), daytime = new Set(daytimeLayerIds), samples = [], cache = new Map();
  const quick = async minute => {
    const m = wrap(minute);
    if (!cache.has(m)) cache.set(m, signatures([{ scene: await evaluate(m), snapshot: { layers: [], unstable: {} } }], exclude, adjust)[0]);
    return cache.get(m);
  };
  const requests = POINTS.map(minute => ({ day: 0, minute }));
  let index = 0;
  await observe(async snapshot => {
    if (snapshot) samples.push({ minute: snapshot.minute, scene: observationScene(await evaluate(snapshot.minute), snapshot), snapshot });
    if (index === POINTS.length && requests.length === POINTS.length) {
      const sigs = signatures(samples, exclude, adjust), extra = new Set();
      for (const id of sigs[0].keys()) {
        if (adjust.has(id) || daytime.has(id)) continue;
        for (let i = 0; i < POINTS.length; i++) {
          if (same(sigs[i].get(id), sigs[(i + 1) % POINTS.length].get(id))) continue;
          const found = await jumps(quick, id, POINTS[i], i < POINTS.length - 1 ? POINTS[i + 1] : POINTS[0] + DAY);
          // 只补看持续 10 分钟以上的中间状态；更短的是切换过程（如脚本一分钟内的过渡），不单独成为一个时段。
          // 最后一次跳变后的状态由区间终点的观察代表。
          if (found?.length > 1) for (let k = 0; k < found.length - 1; k++)
            if (found[k + 1] - found[k] >= 10 && !POINTS.includes(wrap(found[k]))) extra.add(wrap(found[k]));
        }
      }
      requests.push(...[...extra].sort((a, b) => a - b).map(minute => ({ day: 1, minute })));
    }
    return requests[index++] || null;
  });
  samples.sort((a, b) => a.minute - b.minute);
  const minutes = samples.map(sample => sample.minute), sigs = signatures(samples, exclude, adjust);
  const objects = {}, curves = {}, notes = [];
  for (const id of sigs[0].keys()) {
    if (adjust.has(id)) continue;
    const states = sigs.map(map => map.get(id)), name = samples[0].scene.objects.find(object => object.id === id).name ?? id;
    if (daytime.has(id) || states[0].adjust.some(layer => daytime.has(layer.self.id))) { objects[id] = blendVariants(POINTS); continue; }
    if (states.every(state => same(states[0], state))) continue;
    const windows = [];
    for (let i = 0; i < minutes.length; i++) {
      const from = states[i], to = states[(i + 1) % minutes.length];
      windows.push(same(from, to) ? null : await locate(quick, id, minutes[i], i < minutes.length - 1 ? minutes[i + 1] : minutes[0] + DAY, from, to));
    }
    // 区间内多次变化的文字等不能渐变（例如没有识别为时钟的分钟文字），按导出时刻固定。
    if (windows.some((window, i) => window?.gradual && nonInterpolable(states[i], states[(i + 1) % minutes.length]))) {
      notes.push(`${name} · 持续随时间变化，按导出时刻固定`);
      continue;
    }
    if (states.every(state => same(curveBase(states[0]), curveBase(state)))) {
      const alphas = states.map(opacity), maximum = Math.max(...alphas);
      const curve = { minute: minutes[alphas.indexOf(maximum)] };
      const near = key => (x, y) => Array.isArray(x) ? x.every((value, i) => Math.abs(value - y[i]) <= TOLERANCE[key]) : Math.abs(x - y) <= TOLERANCE[key];
      if (alphas.some(alpha => Math.abs(alpha - alphas[0]) > TOLERANCE.alpha))
        curve.alpha = seriesPoints(alphas.map(alpha => maximum ? alpha / maximum : 0), windows, near('alpha'), minutes);
      for (const key of ['origin', 'scale', 'angles']) {
        const values = states.map(state => state.self.render[key]);
        if (values.some(value => !near(key)(values[0], value))) curve[key] = seriesPoints(values, windows, near(key), minutes);
      }
      curves[id] = curve;
      continue;
    }
    objects[id] = stateVariants(states, windows, minutes);
  }
  if (!Object.keys(objects).length && !Object.keys(curves).length && !notes.length) return null;
  const used = [...new Set([...Object.values(objects).flat().map(variant => variant.minute), ...Object.values(curves).map(curve => curve.minute)])].sort((a, b) => a - b);
  for (const item of [...Object.values(objects).flat(), ...Object.values(curves)]) item.scene = used.indexOf(item.minute);
  return { scenes: used.map(minute => samples.find(sample => sample.minute === minute).scene), minutes: used, objects, curves, notes };
}

/** 本地当天 0 点起第 minute 分钟的时间戳。 */
function localMinute(minute) { const date = new Date(); date.setHours(0, 0, 0, 0); return date.getTime() + minute * 60000; }

/** 分段线性关键点在时刻 m 的取值，预览与测试共用。 */
function weightAt(points, minute) {
  let i = 1;
  while (i < points.length - 1 && points[i][0] < minute) i++;
  const [x0, y0] = points[i - 1], [x1, y1] = points[i];
  return x1 === x0 ? y1 : y0 + (y1 - y0) * (minute - x0) / (x1 - x0);
}

module.exports = { planTimeVariants, observationScene, localMinute, weightAt, POINTS };
