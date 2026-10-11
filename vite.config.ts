import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * The Web client dev server proxies the API to the Sprout runtime, so the client
 * can use same-origin `/api` paths in development and in the built output.
 *
 * URL mounts: the Sprout app is the root SPA (`/`) and the design prototype
 * lives at `/prototype`, each with its own `index.html` and SPA fallback for
 * deep links. The retired legacy operator console is kept as source
 * (`web/src/legacy/console.html`) but is not a build entry and has no
 * reachable URL in development or production.
 */
const devPort = Number(process.env.PORT ?? process.env.DEV_PIPELINE_PORT_BASE ?? '41010');

export default defineConfig({
  root: 'web',
  plugins: [
    vue(),
    tailwindcss(),
    {
      // Vite's SPA fallback serves the root index for any extensionless path,
      // which would shadow the prototype mount. Rewrite prototype URLs to the
      // prototype entry so `/prototype` matches production serving.
      name: 'prototype-spa-fallback',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url && (req.url === '/prototype' || (req.url.startsWith('/prototype/') && !req.url.includes('.')))) {
            req.url = '/prototype/index.html';
          }
          next();
        });
      },
    },
  ],
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
    host: '0.0.0.0',
    allowedHosts: true,
    cors: true,
    port: devPort,
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
