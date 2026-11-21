const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');

function registerScheme(protocol) {
  protocol.registerSchemesAsPrivileged([{ scheme: 'yingchuang', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);
}

function createResources(dist) {
  const registeredRoots = new Map(), rootIds = new Map();
  function assetRoot(root) {
    if (!root) return '';
    const absolute = path.resolve(root);
    if (!rootIds.has(absolute)) {
      const id = randomUUID(); rootIds.set(absolute,id); registeredRoots.set(id,absolute);
    }
    return process.env.YINGCHUANG_PREVIEW_PORT ? `http://127.0.0.1:${process.env.YINGCHUANG_PREVIEW_PORT}/asset/${rootIds.get(absolute)}/` : `yingchuang://asset/${rootIds.get(absolute)}/`;
  }
  function fileUrl(file) { return file ? assetRoot(path.dirname(file)) + encodeURIComponent(path.basename(file)) : ''; }
  function rootId(root) { assetRoot(root); return rootIds.get(path.resolve(root)); }
  /** 渲染页与壁纸资源同属 yingchuang://live，网页壁纸可注入属性接口；主界面是另一来源，壁纸脚本无法触及。 */
  function liveBase() { return process.env.YINGCHUANG_PREVIEW_PORT ? `http://127.0.0.1:${process.env.YINGCHUANG_PREVIEW_PORT}/live/` : 'yingchuang://live/'; }
  function liveRoot(root) { return root ? liveBase() + 'r/' + rootId(root) + '/' : ''; }
  function rendererUrl() { return liveBase() + 'app/renderer.html'; }

  function install(protocol, net) {
    protocol.handle('yingchuang',async request => {
      const url = new URL(request.url);
      const pieces = url.pathname.slice(1).split('/');
      let root;
      if (url.host==='live') {
        // live/app 只提供渲染页及其打包资源；live/r 为已登记的壁纸与引擎目录。
        const kind=pieces.shift();
        if (kind==='app'&&(pieces.join('/')==='renderer.html'||pieces[0]==='assets')) root=dist;
        else if (kind==='r') root=registeredRoots.get(pieces.shift());
      } else root = registeredRoots.get(pieces.shift());
      if (!root) return new Response('Not found',{status:404});
      const relative = pieces.map(x=>decodeURIComponent(x)).join('/');
      const target = path.resolve(root,relative);
      if (target!==root && !target.startsWith(root+path.sep)) return new Response('Not found',{status:404});
      try {
        const real = await fs.realpath(target);
        const realRoot = await fs.realpath(root);
        if (real!==realRoot && !real.startsWith(realRoot+path.sep)) return new Response('Not found',{status:404});
        const range=request.headers.get('range');
        const response=await net.fetch(pathToFileURL(real).href,range?{headers:{range}}:undefined);
        if(url.host!=='asset')return response;
        // 主界面试听音乐需要对资源做频谱分析，只读的资源地址允许跨来源读取。
        const headers=new Headers(response.headers);headers.set('Access-Control-Allow-Origin','*');
        return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
      } catch { return new Response('Not found',{status:404}); }
    });
  }
  return { assetRoot, fileUrl, liveRoot, rendererUrl, install, roots: registeredRoots };
}
module.exports = { registerScheme, createResources };
