module.exports = {
  ci: {
    collect: {
      staticDistDir: './dist',
      numberOfRuns: 3,
    },
    upload: {
      target: 'temporary-public-storage',
    },
    assert: {
      preset: 'lighthouse:recommended',
      assertions: {
        // Relaxing some strict PWA requirements for initial launch
        'service-worker': 'off',
        'installable-manifest': 'off',
        'splash-screen': 'off',
        'themed-omnibox': 'off',
        'maskable-icon': 'off',
        // Performance targets
        'first-contentful-paint': ['warn', { maxNumericValue: 1000 }],
        'largest-contentful-paint': ['warn', { maxNumericValue: 1500 }],
        'interactive': ['warn', { maxNumericValue: 2000 }],
      },
    },
  },
};
