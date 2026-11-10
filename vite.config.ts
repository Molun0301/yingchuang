import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
// 主界面与壁纸渲染页分别打包；渲染页由独立来源加载，与主界面隔离。
export default defineConfig({ plugins: [react()], base: './', build: { target: 'es2022', sourcemap: true, chunkSizeWarningLimit: 1500,
  rollupOptions: { input: { index: 'index.html', renderer: 'renderer.html' } } } });
