const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');

class ConversionQueue extends EventEmitter {
  constructor(run) { super(); this.run = run; this.items = []; this.busy = false; this.controller = null; }
  snapshot() { return this.items.map(({ input, ...item }) => ({ ...item })); }
  changed() { this.emit('change', this.snapshot()); }
  add(inputs) {
    for (const input of inputs) this.items.push({ id: randomUUID(), themeId: input.theme.id,
      title: input.theme.title, deviceId: input.draft.deviceId, mode: input.mode, status: 'waiting', progress: 0,
      phase: '等待', input: structuredClone(input), createdAt: Date.now() });
    this.changed(); void this.drain(); return this.snapshot();
  }
  async drain() {
    if (this.busy) return;
    this.busy = true;
    try {
      for (;;) {
        const item = this.items.find(x => x.status === 'waiting');
        if (!item) break;
        item.status = 'running'; item.phase = '读取主题'; item.startedAt = Date.now();
        this.controller = new AbortController(); this.changed();
        try {
          const output = await this.run(item.input, this.controller.signal, event => {
            if (item.status !== 'running') return;
            item.progress = event.progress ?? item.progress; item.phase = event.phase ?? item.phase; this.changed();
          });
          if (item.status === 'running') Object.assign(item, { status: 'done', progress: 100, phase: '已完成', ...output });
        } catch (error) {
          if (this.controller.signal.aborted) Object.assign(item, { status: 'cancelled', phase: '已取消' });
          else Object.assign(item, { status: 'error', phase: '未完成', error: error.message });
        }
        item.finishedAt = Date.now(); this.controller = null; this.changed();
      }
    } finally { this.busy = false; }
  }
  cancel(id) {
    for (const item of this.items) {
      if (id && item.id !== id) continue;
      if (item.status === 'waiting') Object.assign(item, { status: 'cancelled', phase: '已取消' });
      if (item.status === 'running') this.controller?.abort();
    }
    this.changed();
  }
  clear() { this.items = this.items.filter(x => ['waiting','running'].includes(x.status)); this.changed(); }
}
module.exports = { ConversionQueue };
