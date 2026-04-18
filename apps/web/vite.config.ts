import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // `ws: true` forwards the WebSocket upgrade at /api/documents/:uid/events.
      // `configure` silences the benign ECONNRESET the proxy logs whenever a
      // browser navigates away and drops the WS — harmless but noisy.
      '/api': {
        target: 'http://localhost:3434',
        ws: true,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'ECONNRESET' || code === 'EPIPE') return;
            console.error('[vite proxy]', err);
          });
        },
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});
