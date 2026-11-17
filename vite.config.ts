import { defineConfig } from 'vite';

// base 固定 /family/：fairyland 的開發伺服器會把 dist 掛在同源的 /family/ 底下（BroadcastChannel 需同源）。
// 本地單獨起 Vite 開發時，把 /assets 代理到同機的 fairyland dev server，不在本 repo 放任何原版素材。
const assetOrigin = process.env.FAIRYLAND_ORIGIN || 'http://localhost:5173';

export default defineConfig({
  base: '/family/',
  server: {
    port: 3100,
    proxy: {
      '/assets': {
        target: assetOrigin,
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
