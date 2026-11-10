// 开发时在本机浏览器复用桌面应用的实际接口，用于可见的界面检查。
const http=require('node:http');
const fs=require('node:fs/promises');
const {createReadStream}=require('node:fs');
const path=require('node:path');
const aliases={bootstrap:'bootstrap',refresh:'refresh',detail:'detail',fonts:'fonts',saveDraft:'save-draft',livePatch:'live-patch',preview:'preview',previewMotion:'preview-motion',prefetch:'prefetch',clock:'clock',cancelPreview:'cancel-preview',favorite:'favorite',saveTemplate:'save-template',deleteTemplate:'delete-template',applyTemplate:'apply-template',settings:'settings',chooseDirectory:'choose-directory',removeDirectory:'remove-directory',chooseFile:'choose-file',enqueue:'enqueue',cancelQueue:'cancel-queue',clearQueue:'clear-queue',openTheme:'open-theme',openOutput:'open-output',windowControl:'window-control'};
function start({port,handlers,roots,dist}){
  const clients=new Set();
  const bridge=`const events=new EventSource('/events');window.yingchuang={};for(const [key,name] of Object.entries(${JSON.stringify(aliases)})){window.yingchuang[key]=async(...args)=>{const res=await fetch('/api/'+name,{method:'POST',headers:{'Content-Type':'application/json','X-Yingchuang-Preview':'1'},body:JSON.stringify(args)});const data=await res.json();if(!res.ok)throw new Error(data.error);return data;};}for(const [key,name] of Object.entries({onQueue:'queue-change',onPreviewProgress:'preview-progress',onPreviewReady:'preview-ready'})){window.yingchuang[key]=callback=>{const listener=e=>callback(JSON.parse(e.data));events.addEventListener(name,listener);return()=>events.removeEventListener(name,listener);};}`;
  const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.mp4':'video/mp4','.webm':'video/webm','.mov':'video/quicktime'};
  const server=http.createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1:'+port);
    try{
      if(url.pathname==='/events'){res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});res.write(': ready\n\n');clients.add(res);req.on('close',()=>clients.delete(res));return;}
      if(url.pathname==='/bridge.js'){res.writeHead(200,{'Content-Type':types['.js']});res.end(bridge);return;}
      if(url.pathname.startsWith('/api/')){
        if(req.method!=='POST'||req.headers['x-yingchuang-preview']!=='1')throw new Error('请求无效');
        const origin=req.headers.origin;if(origin&&origin!==`http://127.0.0.1:${port}`)throw new Error('请求来源无效');
        const callback=handlers.get(url.pathname.slice(5));if(!callback)throw new Error('未知操作');
        let body='';for await(const chunk of req){body+=chunk;if(body.length>4e6)throw new Error('请求过大');}
        const data=await callback(...JSON.parse(body));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(data??null));return;
      }
      let file,root;
      if(url.pathname.startsWith('/asset/')){const parts=url.pathname.slice(7).split('/');root=roots.get(parts.shift());if(!root)throw new Error('资源不存在');file=path.resolve(root,parts.map(decodeURIComponent).join('/'));}
      else if(url.pathname.startsWith('/live/r/')){const parts=url.pathname.slice(8).split('/');root=roots.get(parts.shift());if(!root)throw new Error('资源不存在');file=path.resolve(root,parts.map(decodeURIComponent).join('/'));}
      else if(url.pathname.startsWith('/live/app/')){root=dist;file=path.resolve(dist,'.'+decodeURIComponent(url.pathname.slice(9)));}
      else{root=dist;file=path.resolve(dist,url.pathname==='/'?'index.html':'.'+decodeURIComponent(url.pathname));}
      if(file!==root&&!file.startsWith(root+path.sep))throw new Error('资源不存在');
      if(['.mp4','.webm','.mov'].includes(path.extname(file).toLowerCase())){
        const stat=await fs.stat(file);const range=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);const start=range?Number(range[1]):0,end=range?.[2]?Math.min(stat.size-1,Number(range[2])):stat.size-1;
        res.writeHead(range?206:200,{'Content-Type':types[path.extname(file)]||'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${stat.size}`}:{})});createReadStream(file,{start,end}).pipe(res);return;
      }
      let data=await fs.readFile(file);
      if(file.endsWith('index.html'))data=Buffer.from(data.toString().replace('<head>','<head><script src="/bridge.js"></script>'));
      res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(data);
    }catch(error){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:error.message}));}
  });
  server.listen(port,'127.0.0.1',()=>console.log('界面检查入口：http://127.0.0.1:'+port));
  return{emit:(name,data)=>{for(const client of clients)client.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);},close:()=>server.close()};
}
module.exports={start};
