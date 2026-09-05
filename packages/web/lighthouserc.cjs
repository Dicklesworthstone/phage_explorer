/**
 * Lighthouse CI configuration.
 *
 * The September 5 repair verifies served production assets with Lighthouse
 * 12.1.0 (LHCI 0.14.0), three runs per page. Evidence, baseline failures, tool
 * versions, and remaining work are recorded in phage_explorer-5t4r.4.
 *
 * Contrast, headings, visible names, console errors, deprecated APIs, and
 * back/forward caching now fail the job on regression. The non-performance
 * category floors are raised after repeated 100s on index and offline pages.
 * Performance thresholds retain the original ratchet; they are not targets
 * or proof that the documented first-visit performance goals have been met.
 *
 * Every retained warning and trace-gatherer exception belongs to the OPEN
 * phage_explorer-5t4r.4. Manual assistive-technology verification is separately
 * owned by phage_explorer-jcud; automated scores do not establish conformance.
 */
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
        // These former PWA audits are absent from Lighthouse 12.1.0.
        // The shipped manifest and service worker have separate browser tests.
        'service-worker': 'off',
        'installable-manifest': 'off',
        'splash-screen': 'off',
        'themed-omnibox': 'off',
        'maskable-icon': 'off',
        // Existing exceptions retained, not certified as non-applicable:
        // Lighthouse 12.1.0 / Chrome 151 reports a RootCauses trace dependency
        // exception (chrome_frame_reporter.frame_sequence) for these audits.
        // phage_explorer-5t4r.4 must resolve tool compatibility and re-enable
        // each audit. A gatherer error is not proof that no LCP image exists.
        'lcp-lazy-loaded': 'off',
        'prioritize-lcp-image': 'off',
        'non-composited-animations': 'off',

        // --- Known open defects, tracked ------------------------------------
        // phage_explorer-5t4r.4 owns source-map validation and the transfer,
        // unused-code, image-sizing, and main-thread performance warnings.
        'valid-source-maps': 'warn',
        'unused-css-rules': 'warn',
        'unused-javascript': 'warn',
        'uses-responsive-images': 'warn',
        'total-byte-weight': 'warn',
        'bootup-time': 'warn',
        'mainthread-work-breakdown': 'warn',
        'max-potential-fid': 'warn',
        'speed-index': 'warn',

        // --- The gate --------------------------------------------------------
        'color-contrast': 'error',
        'heading-order': 'error',
        'label-content-name-mismatch': 'error',
        'bf-cache': 'error',
        deprecations: 'error',
        'errors-in-console': 'error',
        // Category floors, set below today's measured medians with room for
        // run-to-run noise. These are `error`: they fail the build.
        'categories:performance': ['error', { minScore: 0.28 }],
        'categories:accessibility': ['error', { minScore: 0.99 }],
        'categories:best-practices': ['error', { minScore: 0.99 }],
        'categories:seo': ['error', { minScore: 0.99 }],

        // Metric budgets, same ratchet principle. Generous against today's
        // numbers because a build that fails on noise gets disabled, and a
        // disabled gate is the state this file was already in.
        'first-contentful-paint': ['error', { maxNumericValue: 4500 }],
        'largest-contentful-paint': ['error', { maxNumericValue: 34000 }],
        interactive: ['error', { maxNumericValue: 34000 }],
        'total-blocking-time': ['error', { maxNumericValue: 1800 }],
        'cumulative-layout-shift': ['error', { maxNumericValue: 0.3 }],
      },
    },
  },
};
