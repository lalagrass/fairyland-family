import { defineConfig } from 'vite';

// base 固定 /family/：fairyland 的開發伺服器會把 dist 掛在同源的 /family/ 底下（BroadcastChannel 需同源）。
export default defineConfig({
  base: '/family/',
  server: { port: 3100 },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' },
});
