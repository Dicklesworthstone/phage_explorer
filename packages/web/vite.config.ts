import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const resolveFromRoot = (relativePath: string) =>
  path.resolve(__dirname, '..', relativePath);

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Use custom service worker with Workbox strategies
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      injectRegister: false, // We register manually in registerSW.ts
      injectManifest: {
        // Include all build assets in precache
        globPatterns: ['**/*.{js,css,html,woff2,wasm}'],
        // Exclude workers from main precache (they're loaded on demand)
        globIgnores: ['**/node_modules/**', '**/*.worker.js'],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB for database
      },
      devOptions: {
        enabled: false, // Disable in dev to avoid caching issues
      },
      manifest: {
        name: 'Phage Explorer',
        short_name: 'PhageExp',
        description: 'Explore bacteriophage genomes with interactive visualization',
        theme_color: '#00ff41',
        background_color: '#0a0a0a',
        display: 'standalone',
        // Icons omitted - add /icons/icon-192.png and /icons/icon-512.png for PWA install prompt
      },
    }),
  ],
  server: {
    headers: {
      // Enable SharedArrayBuffer for local development
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    // NOTE: Use ordered alias entries to avoid prefix-matching collisions
    // (e.g. `@phage/wasm-compute/simd` should not be rewritten by the base alias).
    alias: [
      { find: '@phage/wasm-compute/simd', replacement: resolveFromRoot('wasm-compute/pkg-simd/wasm_compute.js') },
      { find: '@phage/wasm-compute', replacement: resolveFromRoot('wasm-compute/pkg/wasm_compute.js') },
      { find: '@phage-explorer/core', replacement: resolveFromRoot('core/src') },
      { find: '@phage-explorer/state', replacement: resolveFromRoot('state/src') },
      { find: '@phage-explorer/renderer-3d', replacement: resolveFromRoot('renderer-3d/src') },
      { find: '@phage-explorer/db-schema', replacement: resolveFromRoot('db-schema/src') },
      { find: '@phage-explorer/db-runtime', replacement: resolveFromRoot('db-runtime/src') },
      { find: '@phage-explorer/comparison', replacement: resolveFromRoot('comparison/src') },
      { find: '@phage-explorer/data-pipeline', replacement: resolveFromRoot('data-pipeline/src') },
      { find: '@phage-explorer/tui', replacement: resolveFromRoot('tui/src') },
      { find: 'react/jsx-runtime', replacement: path.resolve(__dirname, 'node_modules/react/jsx-runtime') },
      { find: 'react-dom', replacement: path.resolve(__dirname, 'node_modules/react-dom') },
      { find: 'react', replacement: path.resolve(__dirname, 'node_modules/react') },
      // Browser shims for optional Node deps pulled by sql.js
      { find: 'fs', replacement: resolveFromRoot('web/src/shims/empty.ts') },
      { find: 'path', replacement: resolveFromRoot('web/src/shims/empty.ts') },
      { find: 'crypto', replacement: resolveFromRoot('web/src/shims/empty.ts') },
    ],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-state': ['zustand', 'immer'],
          'vendor-worker': ['comlink'],
          'phage-core': ['@phage-explorer/core'],
          'phage-state': ['@phage-explorer/state'],
          // Group remaining smaller dependencies
          'vendor-utils': [], 
        },
      },
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom', 'sql.js'],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
});
