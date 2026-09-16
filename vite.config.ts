import { defineConfig } from 'vite';

/**
 * The Web client dev server proxies the API to the Sprout runtime, so the client
 * can use same-origin `/api` paths in development and in the built output.
 */
export default defineConfig({
  root: 'web',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: 'web/index.html',
        prototype: 'web/prototype/index.html',
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.SPROUT_PORT ?? '5174'}`,
        changeOrigin: true,
        // Server-sent events must not be buffered by the proxy.
        ws: false,
      },
    },
  },
});
