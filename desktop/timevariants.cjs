// 随时段变化：一天内按 15 分钟采样运行壁纸脚本，找出随时间变化的对象，并为每个对象的各个状态生成一天内的透明度关键点。
const STEP = 15, DAY = 1440, SAMPLES = DAY / STEP;
const ANCESTOR_FIELDS = ['visible', 'alpha', 'origin', 'scale', 'angles', 'color', 'parent'];

/** 对象自身加上祖先的显示与变换：父级随时段隐藏时，子级也算随时段变化 */
function signatures(scene, exclude) {
  const byId = new Map(scene.objects.map(object => [object.id, object]));
  const result = new Map();
  for (const object of scene.objects) {
    if (exclude.has(object.id)) continue;
    const chain = [object];
    for (let parent = byId.get(object.parent); parent && chain.length < 32; parent = byId.get(parent.parent))
      chain.push(Object.fromEntries(ANCESTOR_FIELDS.map(key => [key, parent[key]])));
    result.set(object.id, JSON.stringify(chain));
  }
  return result;
}

/** 循环序列的连续段：[{state, start, length}]，起点对齐到状态变化处 */
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

const wrap = minute => ((minute % DAY) + DAY) % DAY;

/** 某个稳定段在时刻 m 的权重：上层变体渐入/渐出，下层变体在过渡期间保持不透明，叠加后等于两种画面的线性混合 */
function runWeight(run, minute) {
  const rel = wrap(minute - run.a0), A1 = wrap(run.a1 - run.a0), B0 = wrap(run.b0 - run.a0), B1 = wrap(run.b1 - run.a0);
  if (rel < A1) return run.enterOnTop ? rel / A1 : 1;
  if (rel <= B0) return 1;
  if (rel <= B1) return run.exitUnder ? 1 : 1 - (rel - B0) / Math.max(1e-6, B1 - B0);
  return 0;
}

/** 由权重函数取关键点：所有过渡端点及其两侧（含午夜两侧），按上一个保留点去掉共线点 */
function keypoints(weight, breaks) {
  const minutes = [...new Set([0, .01, DAY - .01, DAY, ...breaks.flatMap(m => [m - .01, m, m + .01]).map(m => Math.min(DAY, Math.max(0, m)))])].sort((a, b) => a - b);
  // 1440 与 0 是同一时刻，取左侧极限，避免午夜跳变被插值成斜线。
  const points = minutes.map(m => [Math.round(m * 100) / 100, Math.round(weight(m === DAY ? DAY - 1e-6 : m) * 1000) / 1000]);
  const kept = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const [x0, y0] = kept[kept.length - 1], [x, y] = points[i], [x1, y1] = points[i + 1];
    if (Math.abs(y0 + (y1 - y0) * (x - x0) / (x1 - x0 || 1) - y) > 1e-4) kept.push(points[i]);
  }
  kept.push(points[points.length - 1]);
  return kept;
}

/**
 * evaluate(minute) 返回该时刻求值后的场景；exclude 为不参与的对象（原时钟文字层）。
 * 返回 null 表示没有随时段变化的对象；否则 {scenes, objects, notes}，objects[id] 为该对象各状态的 {scene, minute, alpha}。
 */
async function planTimeVariants(evaluate, exclude = new Set()) {
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) samples.push(await evaluate(i * STEP));
  const sigs = samples.map(scene => signatures(scene, exclude));
  const notes = [], plans = [], cache = new Map();
  const sigAt = async (minute, id) => {
    if (!cache.has(minute)) cache.set(minute, signatures(await evaluate(minute), exclude));
    return cache.get(minute).get(id);
  };
  for (const id of sigs[0].keys()) {
    const states = sigs.map(map => map.get(id));
    if (states.every(state => state === states[0])) continue;
    const name = samples[0].objects.find(object => object.id === id)?.name ?? id;
    const runs = cyclicRuns(states);
    // 大部分时刻都在变化的（秒、分钟显示等）无法按时段拆分，保持导出时刻的状态。
    if (runs.filter(run => run.length === 1).length > SAMPLES * .6) { notes.push(`${name} 持续随时间变化，按导出时刻固定`); continue; }
    let stable = runs.filter(run => run.length >= 2);
    stable = stable.filter((run, i) => i === 0 || run.state !== stable[i - 1].state);
    if (stable.length > 1 && stable[0].state === stable[stable.length - 1].state) { stable[0] = { ...stable[0], start: stable[stable.length - 1].start, length: stable[0].length + stable[stable.length - 1].length }; stable.pop(); }
    if (stable.length < 2) continue;
    const variants = [...new Set(stable.map(run => run.state))];
    if (variants.length > 8) { notes.push(`${name} 时段状态超过 8 种，按导出时刻固定`); continue; }
    // 相邻稳定段之间：中间有过渡采样的按线性渐变；紧挨着的是瞬间切换，按分钟二分定位切换时刻。
    const windows = [];
    for (let i = 0; i < stable.length; i++) {
      const from = stable[i], to = stable[(i + 1) % stable.length];
      const end = (from.start + from.length - 1) * STEP, begin = to.start * STEP;
      if (wrap(begin - end) === STEP) {
        let low = end, high = end + STEP;
        while (high - low > 1) { const mid = Math.floor((low + high) / 2); if (await sigAt(wrap(mid), id) === to.state) high = mid; else low = mid; }
        windows.push([wrap(high), wrap(high)]);
      } else windows.push([wrap(end), wrap(begin)]);
    }
    const runsInfo = stable.map((run, i) => {
      const before = windows[(i - 1 + stable.length) % stable.length], after = windows[i];
      const variant = variants.indexOf(run.state), previous = variants.indexOf(stable[(i - 1 + stable.length) % stable.length].state), next = variants.indexOf(stable[(i + 1) % stable.length].state);
      return { variant, a0: before[0], a1: before[1], b0: after[0], b1: after[1], enterOnTop: variant > previous, exitUnder: next > variant, run };
    });
    const breaks = windows.flat();
    plans.push({ id, variants: variants.map((state, v) => {
      const longest = stable.filter(run => run.state === state).sort((a, b) => b.length - a.length)[0];
      const minute = wrap((longest.start + Math.floor((longest.length - 1) / 2)) * STEP);
      const mine = runsInfo.filter(info => info.variant === v);
      return { minute, alpha: keypoints(m => Math.min(1, mine.reduce((sum, info) => sum + runWeight(info, m), 0)), breaks) };
    }) });
  }
  if (!plans.length) return notes.length ? { scenes: [], objects: {}, notes } : null;
  const minutes = [...new Set(plans.flatMap(plan => plan.variants.map(variant => variant.minute)))].sort((a, b) => a - b);
  return {
    scenes: minutes.map(minute => samples[minute / STEP]), minutes, notes,
    objects: Object.fromEntries(plans.map(plan => [String(plan.id), plan.variants.map(variant => ({ scene: minutes.indexOf(variant.minute), minute: variant.minute, alpha: variant.alpha }))])),
  };
}

/** 本地当天 0 点起第 minute 分钟的时间戳 */
function localMinute(minute) { const date = new Date(); date.setHours(0, 0, 0, 0); return date.getTime() + minute * 60000; }

/** 分段线性关键点在时刻 m 的取值（预览与测试共用） */
function weightAt(points, minute) {
  let i = 1;
  while (i < points.length - 1 && points[i][0] < minute) i++;
  const [x0, y0] = points[i - 1], [x1, y1] = points[i];
  return x1 === x0 ? y1 : y0 + (y1 - y0) * (minute - x0) / (x1 - x0);
}

module.exports = { planTimeVariants, localMinute, weightAt, STEP };
