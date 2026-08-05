import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** A launcher may set these to anything; a bad value should not start a
 *  server on port NaN, so fall back to the default instead. */
function envPort(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    console.warn(`[vite] ignoring ${name}=${raw}; using ${fallback}`);
    return fallback;
  }
  return parsed;
}

const port = envPort('PORT', 5173);
const serverPort = envPort('MARGINALIA_SERVER_PORT', 3434);

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
