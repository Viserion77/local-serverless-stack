import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  css: {
    postcss: null,
  },
  build: {
    outDir: '../../dist/ui',
    emptyOutDir: true,
  },
  server: {
    port: 3101,
    proxy: {
      '/api': {
        target: 'http://localhost:14566',
        changeOrigin: true,
      },
    },
  },
});
