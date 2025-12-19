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
        icons: [
          {
            src: '/icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
        ],
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
    alias: {
      '@phage-explorer/core': resolveFromRoot('core/src'),
      '@phage-explorer/state': resolveFromRoot('state/src'),
      '@phage-explorer/renderer-3d': resolveFromRoot('renderer-3d/src'),
      '@phage-explorer/db-schema': resolveFromRoot('db-schema/src'),
      '@phage-explorer/db-runtime': resolveFromRoot('db-runtime/src'),
      '@phage-explorer/comparison': resolveFromRoot('comparison/src'),
      '@phage-explorer/data-pipeline': resolveFromRoot('data-pipeline/src'),
      '@phage-explorer/tui': resolveFromRoot('tui/src'),
      '@phage/wasm-compute': resolveFromRoot('wasm-compute/pkg/wasm_compute.js'),
      react: path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime'),
      // Browser shims for optional Node deps pulled by sql.js
      fs: resolveFromRoot('web/src/shims/empty.ts'),
      path: resolveFromRoot('web/src/shims/empty.ts'),
      crypto: resolveFromRoot('web/src/shims/empty.ts'),
    },
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
