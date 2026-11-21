const path = require('node:path');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const { randomUUID } = require('node:crypto');

const BUILD_LIMIT = 2e9;
const fileKey = file => process.platform==='win32' ? path.resolve(file).toLowerCase() : path.resolve(file);
const safeName = value => value.replace(/[<>:"/\\|?*\x00-\x1f]/g,'_');
const sameSlot = (record, themeId, deviceId) => record.themeId===themeId&&record.deviceId===deviceId;

async function folderSize(folder) {
  const entries=await fs.readdir(folder,{recursive:true,withFileTypes:true});
  let size=0;
  for(const entry of entries)if(entry.isFile())size+=(await fs.stat(path.join(entry.parentPath,entry.name))).size;
  return size;
}

class Builds {
  constructor({store,userData,fileUrl,notify}) {
    this.store=store;this.root=path.join(userData,'builds');this.fileUrl=fileUrl;this.notify=notify;
    this.pending=new Map();this.writing=Promise.resolve();
  }

  prepare({theme,device,outputDirectory}) {
    const stem=safeName(theme.title+' · '+device.name);
    const primary=path.resolve(outputDirectory,stem+'.mrc');
    const suffix=path.resolve(outputDirectory,stem+' · '+(theme.workshopId||theme.id.slice(0,6))+'.mrc');
    const records=[...this.store.data.builds,...this.pending.values()];
    const occupied=records.some(record=>record.themeId!==theme.id&&fileKey(record.file)===fileKey(primary));
    const usedSuffix=records.some(record=>sameSlot(record,theme.id,device.id)&&fileKey(record.file)===fileKey(suffix));
    const id=randomUUID(), outputFile=occupied||usedSuffix?suffix:primary;
    this.pending.set(id,{themeId:theme.id,deviceId:device.id,file:outputFile});
    return {id,outputFile,buildDirectory:path.join(this.root,id)};
  }

  async run(input, signal, progress, convert) {
    const {id,...paths}=this.prepare(input);
    try {
      const result=await convert({...input,...paths},signal,progress);
      const {theme,device,mode,project}=input;
      await this.commit({id,themeId:theme.id,title:theme.title,deviceId:device.id,mode,
        quality:project.export.quality,timeVariation:project.export.timeVariation,createdAt:Date.now(),
        file:result.path,folder:result.folder,size:result.size,notes:result.notes});
      return {buildId:id,size:result.size};
    } finally { this.pending.delete(id); }
  }

  write(callback) {
    const task=this.writing.then(callback);
    this.writing=task.catch(()=>{});
    return task;
  }

  commit(record) {
    return this.write(async()=>{
      const data=this.store.data;
      const previous=data.builds.filter(item=>sameSlot(item,record.themeId,record.deviceId));
      data.builds=[record,...data.builds.filter(item=>!previous.includes(item))];
      this.store.save();
      for(const item of previous)await fs.rm(item.folder,{recursive:true,force:true});
      await this.prune();
      this.changed();
    });
  }

  async prune() {
    const entries=[];
    let total=0;
    for(const {folder} of this.store.data.builds){
      const stat=await fs.stat(folder).catch(error=>{if(error.code!=='ENOENT')throw error;});
      if(!stat)continue;
      const size=await folderSize(folder);
      total+=size;entries.push({folder,time:stat.mtimeMs,size});
    }
    for(const entry of entries.sort((a,b)=>a.time-b.time)){
      if(total<=BUILD_LIMIT)break;
      await fs.rm(entry.folder,{recursive:true,force:true});
      total-=entry.size;
    }
  }

  snapshot() {
    return this.store.data.builds.map(({folder,...record})=>{
      const preview=path.join(folder,'preview.jpg');
      return {...record,preview:existsSync(preview)?this.fileUrl(preview):'',fileExists:existsSync(record.file),folderAvailable:existsSync(folder)};
    });
  }

  changed() { const builds=this.snapshot();this.notify(builds);return builds; }

  byId(id) {
    const record=this.store.data.builds.find(item=>item.id===id);
    if(!record)throw new Error('成品记录已移除。');
    return record;
  }

  report(id) {
    return this.write(async()=>{
      const {folder}=this.byId(id);
      if(!existsSync(folder))throw new Error('成品目录已清理，可重新导出壁纸。');
      const raw=JSON.parse(await fs.readFile(path.join(folder,'转换报告.json'),'utf8'));
      await fs.utimes(folder,new Date(),new Date());
      return {notes:raw['未迁移及注意事项'],restored:raw['恢复效果'],layers:raw['图层数量'],raw};
    });
  }

  preview(id) {
    return this.write(async()=>{
      const {folder}=this.byId(id),file=path.join(folder,'交互预览.html');
      if(!existsSync(file))return '';
      await fs.utimes(folder,new Date(),new Date());
      return this.fileUrl(file);
    });
  }

  remove(id) {
    return this.write(async()=>{
      const record=this.byId(id);
      await fs.rm(record.folder,{recursive:true,force:true});
      this.store.update(data=>{data.builds=data.builds.filter(item=>item!==record);});
      return this.changed();
    });
  }
}

module.exports = { Builds };
