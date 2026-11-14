const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const os = require('node:os');

// 同时导出的数量；逐层渲染的隐藏窗口另有全局名额（recorder.cjs），多项并行时不会成倍占用显存。
const CONCURRENCY = Math.min(3, Math.max(1, Math.floor(os.cpus().length / 8)));

class ConversionQueue extends EventEmitter {
  constructor(run, concurrency = 1) { super(); this.run = run; this.items = []; this.running = 0; this.concurrency = concurrency; this.controllers = new Map(); }
  snapshot() { return this.items.map(({ input, ...item }) => ({ ...item })); }
  changed() { this.emit('change', this.snapshot()); }
  add(inputs) {
    for (const input of inputs) this.items.push({ id: randomUUID(), themeId: input.theme.id,
      title: input.theme.title, deviceId: input.draft.deviceId, mode: input.mode, status: 'waiting', progress: 0,
      phase: '等待', input: structuredClone(input), createdAt: Date.now() });
    this.changed(); this.drain(); return this.snapshot();
  }
  drain() {
    while (this.running < this.concurrency) {
      const item = this.items.find(x => x.status === 'waiting');
      if (!item) return;
      this.running++;
      void this.start(item).finally(() => { this.running--; this.drain(); });
    }
  }
  async start(item) {
    const controller = new AbortController();
    this.controllers.set(item.id, controller);
    item.status = 'running'; item.phase = '读取主题'; item.startedAt = Date.now(); this.changed();
    try {
      const output = await this.run(item.input, controller.signal, event => {
        if (item.status !== 'running') return;
        item.progress = event.progress ?? item.progress; item.phase = event.phase ?? item.phase; this.changed();
      });
      if (item.status === 'running') Object.assign(item, { status: 'done', progress: 100, phase: '已完成', ...output });
    } catch (error) {
      if (controller.signal.aborted) Object.assign(item, { status: 'cancelled', phase: '已取消' });
      else Object.assign(item, { status: 'error', phase: '未完成', error: error.message });
    }
    item.finishedAt = Date.now(); this.controllers.delete(item.id); this.changed();
  }
  cancel(id) {
    for (const item of this.items) {
      if (id && item.id !== id) continue;
      if (item.status === 'waiting') Object.assign(item, { status: 'cancelled', phase: '已取消' });
      if (item.status === 'running') this.controllers.get(item.id)?.abort();
    }
    this.changed();
  }
  clear() { this.items = this.items.filter(x => ['waiting','running'].includes(x.status)); this.changed(); }
}
module.exports = { ConversionQueue, CONCURRENCY };
