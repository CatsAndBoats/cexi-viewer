import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',                       // relative asset paths for Tauri embedding
  build: { target: 'esnext' },
  server: {
    port: 5173,        // fixed so tauri.conf.json devUrl stays valid
    strictPort: true,  // fail loudly rather than drift to another port
    proxy: {
      // Browser dev mode: python dev/serve.py 8766 provides the /fs API
      '/fs': 'http://127.0.0.1:8766',
    },
  },
});
