// 在实际 Electron 窗口中检查小窗口、缩放、下拉和时间编辑。
const {_electron:electron}=require('playwright');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {Store}=require('../desktop/store.cjs');

(async()=>{
  const root=path.resolve(__dirname,'..'),output=path.join(root,'test-results/窗口验收');
  fs.mkdirSync(output,{recursive:true});
  const data=path.join(output,'数据'),store=new Store(data);
  store.data.settings.roots=[path.join(root,'test-results/窗口样例')];store.save();
  const packaged=process.env.YINGCHUANG_PACKAGED_APP;
  const app=await electron.launch({...(packaged?{executablePath:path.resolve(packaged)}:{}),args:[...(packaged?[]:[root]),'--force-device-scale-factor=1.5'],env:{...process.env,YINGCHUANG_DATA_DIR:data,
    YINGCHUANG_PYTHON:process.platform==='win32'?path.join(root,'runtime/win/python.exe'):path.join(root,'.venv/bin/python'),YINGCHUANG_DISABLE_GPU:'1'}});
  const errors=[],measurements=[];
  try{
    const page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
    await page.getByPlaceholder('搜索壁纸').fill('窗口回归样例');
    await page.locator('.card-picture').click();await page.locator('canvas[data-scene-ready=true]').waitFor();
    await page.locator('.inspector-tabs').getByRole('button',{name:'时间',exact:true}).click();
    await page.getByRole('combobox',{name:'时间格式'}).click();await page.getByRole('option',{name:'12 小时',exact:true}).click();
    assert.match(await page.getByRole('combobox',{name:'时间格式'}).innerText(),/12 小时/);
    await page.getByRole('button',{name:'主题',exact:true}).click();
    await page.getByRole('combobox',{name:'样例下拉列表'}).click();
    await page.getByRole('textbox',{name:'搜索样例下拉列表'}).fill('24');await page.getByRole('option',{name:'选项 24',exact:true}).click();
    assert.match(await page.getByRole('combobox',{name:'样例下拉列表'}).innerText(),/24/);
    await page.getByRole('button',{name:'排版',exact:true}).last().click();
    const input=page.getByRole('spinbutton',{name:'缩放数值',exact:true}),before=Number(await input.inputValue());
    await page.locator('canvas').hover();await page.mouse.wheel(0,-160);assert(Number(await input.inputValue())>before);
    for(const [width,height] of [[1280,800],[960,640],[850,560]]){
      await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setSize(...size),[width,height]);
      await page.waitForFunction(size=>innerWidth===size[0]&&innerHeight===size[1],[width,height]);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      await page.locator('.inspector-tabs').getByRole('button',{name:'时间',exact:true}).click();await page.getByRole('combobox',{name:'时间字体'}).click();
      const box=await page.locator('.select-popup').boundingBox();
      assert(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=height+1);
      await page.screenshot({path:path.join(output,`${width}x${height}.png`)});
      await page.keyboard.press('Escape');assert(await page.getByRole('dialog').isVisible());
      const footer=await page.locator('.editor-footer').boundingBox();assert(footer.y+footer.height<=height+1);
      measurements.push({width,height,menu:box,footer});
    }
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'结果.json'),JSON.stringify({platform:process.platform,scale:1.5,measurements,errors},null,2));
    console.log('窗口、菜单、时间和滚轮检查通过');
  }finally{await app.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
