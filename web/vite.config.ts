import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = path.resolve(__dirname);
const projectRoot = path.resolve(__dirname, '..');

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: {
      // 前后端 DTO 契约只有一份来源：src/types/api.ts
      '@shared/api': path.resolve(projectRoot, 'src/types/api.ts'),
    },
  },
  server: {
    port: 5173,
    // 开发态把所有后端入口代理到 express，避免前端另起一套 mock
    proxy: Object.fromEntries(
      ['/api', '/v1', '/admin/api', '/healthz'].map((prefix) => [
        prefix,
        { target: 'http://localhost:3000', changeOrigin: true },
      ]),
    ),
  },
  build: {
    outDir: path.resolve(root, 'dist'),
    emptyOutDir: true,
    sourcemap: false,
  },
});