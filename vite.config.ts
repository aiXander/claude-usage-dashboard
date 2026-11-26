import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.PORT || 5178;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5179,
    open: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
