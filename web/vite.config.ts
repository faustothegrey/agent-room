import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  base: './',
  plugins: [react()],
  // Keep the room page's CSS as written: light-dark() is supported by these browsers, so it isn't
  // rewritten into variables that follow only the OS theme.
  build: { outDir: 'dist', cssTarget: ['chrome123', 'safari17.5', 'firefox120', 'edge123'] },
});
