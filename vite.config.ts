import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': `http://127.0.0.1:${process.env.API_PORT ?? 3000}` },
  },
});
