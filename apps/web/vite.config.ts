import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const port = Number(process.env.PORT ?? 5173);
const serverPort = Number(process.env.MARGINALIA_SERVER_PORT ?? 3434);

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
    proxy: {
      // `ws: true` forwards the WebSocket upgrade at /api/documents/:uid/events.
      // `configure` silences the benign ECONNRESET the proxy logs whenever a
      // browser navigates away and drops the WS — harmless but noisy.
      '/api': {
        target: `http://localhost:${serverPort}`,
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
    chunkSizeWarningLimit: 650,
  },
});
