import { defineConfig } from 'vite';

// base: './' keeps asset URLs relative so the build works inside Capacitor's
// native WebView (file/capacitor scheme) as well as on a normal web host.
export default defineConfig({
  base: './',
  assetsInclude: ['**/*.glb', '**/*.rgb'],
  // host + allowedHosts let Replit / phones on the LAN open the dev server.
  server: { host: true, port: 5173, allowedHosts: true },
  preview: { host: true, port: 5173, allowedHosts: true },
  build: {
    target: 'es2020',
    outDir: 'dist',
    // Inline the bundled fonts (single-file / offline builds); keep music files external.
    assetsInlineLimit: (file: string) => /\.woff2?$/.test(file),
    chunkSizeWarningLimit: 1200,
  },
});
