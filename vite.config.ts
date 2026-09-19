import tailwindcss from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * The Web client dev server proxies the API to the Sprout runtime, so the client
 * can use same-origin `/api` paths in development and in the built output.
 */
const devPort = Number(process.env.PORT ?? process.env.DEV_PIPELINE_PORT_BASE ?? '41010');

export default defineConfig({
  root: 'web',
  plugins: [
    vue(),
    tailwindcss(),
    {
      name: 'app-spa-fallback',
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.url && (req.url === '/app' || (req.url.startsWith('/app/') && !req.url.includes('.')))) {
            req.url = '/app/index.html';
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
        app: 'web/app/index.html',
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
