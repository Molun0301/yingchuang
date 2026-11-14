const test=require('node:test');
const assert=require('node:assert/strict');
const {ConversionQueue}=require('../desktop/queue.cjs');
const {defaultDraft}=require('../desktop/model.cjs');

const item=id=>({theme:{id,title:id},draft:defaultDraft()});
const settled=queue=>new Promise(resolve=>{const check=items=>{if(items.every(x=>!['waiting','running'].includes(x.status))){queue.off('change',check);resolve(items);}};queue.on('change',check);check(queue.snapshot());});

test('并行导出：同时运行的项数等于并发数，前面的完成后补上等待项',async()=>{
  let running=0,peak=0;const releases=[];
  const queue=new ConversionQueue(()=>new Promise(resolve=>{running++;peak=Math.max(peak,running);releases.push(()=>{running--;resolve({});});}),2);
  queue.add(['一','二','三','四'].map(item));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(releases.length,2);
  releases.shift()();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(releases.length,2);
  while(releases.length){releases.shift()();await new Promise(resolve=>setImmediate(resolve));}
  const items=await settled(queue);
  assert.equal(peak,2);assert.deepEqual(items.map(x=>x.status),['done','done','done','done']);
});

test('并行导出：取消其中一项只停止这一项',async()=>{
  const finish={};
  const queue=new ConversionQueue((input,signal)=>new Promise((resolve,reject)=>{finish[input.theme.id]=resolve;signal.addEventListener('abort',()=>reject(new Error('已取消')),{once:true});}),3);
  queue.add(['一','二','三'].map(item));
  await new Promise(resolve=>setImmediate(resolve));
  queue.cancel(queue.snapshot()[1].id);finish['一']({});finish['三']({});
  const items=await settled(queue);
  assert.deepEqual(items.map(x=>x.status),['done','cancelled','done']);
});
