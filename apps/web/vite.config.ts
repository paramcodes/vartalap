import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev proxy keeps same-origin in development the same way `src/server.ts`
// keeps it in production: `/api/*` goes to the realtime service, so the
// shell only ever fetches relatively and the `lax` cookie survives (ADR 0062).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.REALTIME_URL ?? 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
