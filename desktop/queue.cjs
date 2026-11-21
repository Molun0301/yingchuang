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
      title: input.theme.title, deviceId: input.device.id, mode: input.mode, status: 'waiting', progress: 0,
      phase: '等待', input: structuredClone(input), createdAt: Date.now() });
    this.changed(); this.drain(); return this.snapshot();
  }
  drain() {
    while (this.running < this.concurrency) {
      // 同一壁纸、同一机型共用一个导出文件，按入队顺序写入。其他壁纸仍可并行。
      const item = this.items.find(x => x.status === 'waiting' && !this.items.some(active =>
        active.status === 'running' && active.themeId === x.themeId && active.deviceId === x.deviceId));
      if (!item) return;
      this.running++;
      void this.start(item).finally(() => { this.running--; this.drain(); });
    }
  }
  async start(item) {
    const controller = new AbortController();
    this.controllers.set(item.id, controller);
    item.status = 'running'; item.phase = '读取壁纸'; item.startedAt = Date.now(); this.changed();
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
  whenIdle() {
    return new Promise(resolve=>{
      const check=items=>{
        if(items.some(activeItem))return;
        this.off('change',check);resolve();
      };
      this.on('change',check);check(this.items);
    });
  }
  clear() { this.items = this.items.filter(activeItem); this.changed(); }
}
function activeItem(item) { return item.status==='waiting'||item.status==='running'; }

function queueFeedback({queue,getWindow,notify,Notification,focusWindow}) {
  const batch=new Map();
  queue.on('change',items=>{
    for(const item of items)if(activeItem(item)||batch.has(item.id))batch.set(item.id,item);
    const window=getWindow(),active=items.some(activeItem),entries=[...batch.values()];
    if(window&&!window.isDestroyed()){
      const progress=entries.reduce((sum,item)=>sum+(activeItem(item)?item.progress:100),0);
      window.setProgressBar(active?Math.max(0,Math.min(1,progress/entries.length/100)):-1);
    }
    notify('queue-change',items);
    if(active||!batch.size)return;
    batch.clear();
    if((window&&!window.isDestroyed()&&window.isFocused())||!Notification.isSupported())return;
    const done=entries.filter(item=>item.status==='done').length,unfinished=entries.length-done;
    const body=unfinished?`${done} 张已导出，${unfinished} 张未完成`:`${done} 张壁纸已导出`;
    const notification=new Notification({title:'转换完成',body});
    notification.on('click',focusWindow);notification.show();
  });
}

module.exports = { ConversionQueue, CONCURRENCY, queueFeedback };
