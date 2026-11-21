const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const {existsSync}=require('node:fs');
const path=require('node:path');
const {Builds}=require('../desktop/builds.cjs');
const {Store}=require('../desktop/store.cjs');
const {model}=require('../desktop/projects.cjs');

test('并行导出的同名壁纸使用不同文件，重导只替换同壁纸同机型的成品',async()=>{
  const dir=await fs.mkdtemp(path.join(__dirname,'builds-'));
  try{
    const store=new Store(dir),pushed=[];
    const builds=new Builds({store,userData:dir,fileUrl:file=>'yingchuang://asset/'+encodeURIComponent(path.basename(file)),
      notify:snapshot=>pushed.push(snapshot)});
    const outputDirectory=path.join(dir,'导出');
    await fs.mkdir(outputDirectory);
    const input={theme:{id:'abcdef123456',title:'大海:夜景',workshopId:''},
      device:{id:'device',name:'小米 17 Pro'},mode:'layers',project:model.create(),outputDirectory};
    const other={...input,theme:{id:'438274',title:'大海?夜景',workshopId:'438274'}};
    const report={'未迁移及注意事项':['示例'],'恢复效果':['图层动效'],'图层数量':2};
    async function convert({buildDirectory,outputFile,theme}) {
      await fs.mkdir(buildDirectory,{recursive:true});
      await fs.writeFile(outputFile,theme.id);
      await fs.writeFile(path.join(buildDirectory,'preview.jpg'),'预览');
      await fs.writeFile(path.join(buildDirectory,'交互预览.html'),'<html/>');
      await fs.writeFile(path.join(buildDirectory,'转换报告.json'),JSON.stringify(report));
      return {path:outputFile,folder:buildDirectory,size:theme.id.length,notes:1,preview:path.join(buildDirectory,'preview.jpg')};
    }
    const run=input=>builds.run(input,undefined,()=>{},convert);
    const [a,b]=await Promise.all([run(input),run(other)]);
    const aRecord=builds.byId(a.buildId),bRecord=builds.byId(b.buildId);
    assert.equal(a.size,12);assert.equal(aRecord.folder,path.join(dir,'builds',a.buildId));
    assert.equal(path.basename(aRecord.file),'大海_夜景 · 小米 17 Pro.mrc');
    assert.equal(path.basename(bRecord.file),'大海_夜景 · 小米 17 Pro · 438274.mrc');
    assert.equal(await fs.readFile(aRecord.file,'utf8'),input.theme.id);
    assert.equal(await fs.readFile(bRecord.file,'utf8'),other.theme.id);
    const local={...input,theme:{...input.theme,id:'1122334455'}};
    const c=await run(local);
    assert.equal(path.basename(builds.byId(c.buildId).file),'大海_夜景 · 小米 17 Pro · 112233.mrc');

    const alternate=await run({...input,device:{id:'another',name:'小米 17 Pro Max'}});
    const replacement=await run(input);
    assert.equal(builds.byId(replacement.buildId).file,aRecord.file);
    assert(!existsSync(aRecord.folder));
    assert(!store.data.builds.some(record=>record.id===a.buildId));
    assert(existsSync(bRecord.folder));
    assert(existsSync(builds.byId(alternate.buildId).folder));
    const current=builds.snapshot().find(record=>record.id===replacement.buildId);
    assert.equal(current.preview,'yingchuang://asset/preview.jpg');assert(current.fileExists&&current.folderAvailable);
    assert(!('folder'in current));assert.equal(current.notes,1);
    assert.deepEqual(await builds.report(replacement.buildId),{notes:['示例'],restored:['图层动效'],layers:2,raw:report});
    assert.equal(await builds.preview(replacement.buildId),'yingchuang://asset/'+encodeURIComponent('交互预览.html'));
    assert.deepEqual(await builds.remove(b.buildId),pushed.at(-1));
    assert(existsSync(bRecord.file));assert(!existsSync(bRecord.folder));
    assert.deepEqual(new Store(dir).data.builds,store.data.builds);
  }finally{await fs.rm(dir,{recursive:true,force:true});}
});
