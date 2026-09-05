import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Build id, baked into the client and used to version every API cache entry.
 *
 * A cached analysis outlives the code that produced it, and two overlays cached
 * results under a "REAL DATA" label with a 24 hour TTL. Without this, a deploy
 * that fixed a fabricated analysis would still serve the fabricated result back
 * to anyone who had opened the previous build that day. Tying the cache key to
 * the build means a deploy invalidates automatically, with nobody having to
 * remember to bump a constant.
 *
 * Package version plus the commit it was built from. Falls back to the build
 * timestamp when git is unavailable (a source tarball, a container without the
 * .git directory), which is coarser but never collides across builds.
 */
function resolveBuildId(): string {
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')
  ) as { version?: string };
  const version = pkg.version ?? '0.0.0';
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (sha) return `${version}-${sha}`;
  } catch {
    // git missing or not a repository; fall through to the timestamp
  }
  return `${version}-${Date.now().toString(36)}`;
}

const BUILD_ID = resolveBuildId();

const require = createRequire(import.meta.url);
const resolveFromRoot = (relativePath: string) =>
  path.resolve(__dirname, '..', relativePath);
const resolveInstalledEntry = (specifier: string) => require.resolve(specifier);
const resolveInstalledPackage = (specifier: string) =>
  path.dirname(resolveInstalledEntry(specifier));

export default defineConfig({
  define: {
    __CACHE_VERSION__: JSON.stringify(BUILD_ID),
  },
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
        start_url: '/',
        scope: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
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
    cors: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'cross-origin',
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
      // Match only the bare package import. The adapter's deep sql.js imports
      // must continue resolving to the upstream browser build and WASM asset.
      { find: /^sql\.js$/, replacement: resolveFromRoot('web/src/db/sqljs-runtime.js') },
      // Resolve from the config's module graph rather than assuming a package-local
      // node_modules directory; both hoisted workspaces and Vercel installs are valid.
      { find: 'react/jsx-runtime', replacement: resolveInstalledEntry('react/jsx-runtime') },
      { find: 'react-dom', replacement: resolveInstalledPackage('react-dom') },
      { find: 'react', replacement: resolveInstalledPackage('react') },
      // Browser shims for optional Node deps pulled by sql.js
      { find: 'fs', replacement: resolveFromRoot('web/src/shims/empty.ts') },
      { find: 'path', replacement: resolveFromRoot('web/src/shims/empty.ts') },
      { find: 'crypto', replacement: resolveFromRoot('web/src/shims/empty.ts') },
    ],
  },
  worker: {
    format: 'es',
    rollupOptions: {
      output: {
        // Force .js extension for workers to avoid MIME type issues on CDNs
        // (.ts is interpreted as MPEG-2 Transport Stream, not JavaScript)
        entryFileNames: 'assets/[name]-[hash].js',
      },
    },
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
    include: ['react', 'react-dom', 'sql.js/dist/sql-wasm.js'],
    esbuildOptions: {
      define: {
        global: 'globalThis',
      },
    },
  },
});
