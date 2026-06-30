import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies the backend so the browser talks to one origin.
const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:8799';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/mcp': { target: BACKEND, changeOrigin: true },
    },
  },
});
