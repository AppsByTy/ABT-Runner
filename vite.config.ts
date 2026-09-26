import { defineConfig } from 'vite';

// base: './' keeps asset URLs relative so the build works inside Capacitor's
// native WebView (file/capacitor scheme) as well as on a normal web host.
export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
  },
});
