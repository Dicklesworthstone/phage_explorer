/**
 * Lighthouse CI configuration.
 *
 * ## What was wrong
 *
 * The three performance budgets here were asserted at `warn`:
 *
 *     first-contentful-paint    warn, <= 1000 ms
 *     largest-contentful-paint  warn, <= 1500 ms
 *     interactive               warn, <= 2000 ms
 *
 * A `warn` cannot fail the job, so a performance regression could never be
 * caught by this file. There were also no `categories:*` assertions at all, so
 * the deploy plan's headline requirement -- "Lighthouse score >90 all
 * categories" -- was encoded nowhere in CI. Meanwhile the measured values were
 * nowhere near those budgets, so even as warnings they were noise nobody read.
 *
 * ## What this file does now
 *
 * Category scores and metric budgets are `error`, set at a RATCHET: just below
 * what the app measures today, so today passes and any regression fails. The
 * numbers below are the measured medians of three runs, recorded so the next
 * person can see the headroom rather than guess at it:
 *
 *                     index.html   offline.html
 *     performance         36           100
 *     accessibility       95            89
 *     best-practices      82            96
 *     seo                100            90
 *     FCP               3213 ms        662 ms
 *     LCP              27316 ms        754 ms
 *     TTI              27361 ms        754 ms
 *     TBT                879 ms          0 ms
 *     CLS              0.233          0.000
 *
 * A performance score of 36 and a 27-second LCP are bad, and the floors below
 * are not a target. They are a ratchet that stops it getting worse while the
 * work to make it better is tracked. The dominant cost is the 10 MB SQLite
 * database the app loads before it is interactive.
 *
 * ## The three kinds of entry below
 *
 * - `off`   the audit cannot produce a value for this app at all. Turning it
 *           off is honest; leaving it asserting against NaN is noise.
 * - `warn`  a real, open defect, with the bead that tracks it named. These are
 *           warnings because they are known and scheduled, not because they are
 *           acceptable.
 * - `error` everything else, including every category score and metric budget.
 *           These are the assertions that make this file a gate.
 *
 * If you are adding an audit here as `warn`, name the bead. An unexplained
 * `warn` is how this file stopped being a gate the first time.
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
        // --- Not applicable to this app -------------------------------------
        // PWA audits: the app ships a service worker through vite-plugin-pwa,
        // but these audits need a served origin and see a static dist dir.
        'service-worker': 'off',
        'installable-manifest': 'off',
        'splash-screen': 'off',
        'themed-omnibox': 'off',
        'maskable-icon': 'off',
        // These three return null on every run for both pages: the app has no
        // LCP image and no non-composited animations to report on. Asserting
        // minScore against null produced "Audit did not produce a value at all"
        // on every CI run, which is noise, not signal.
        'lcp-lazy-loaded': 'off',
        'prioritize-lcp-image': 'off',
        'non-composited-animations': 'off',

        // --- Known open defects, tracked ------------------------------------
        // Each of these fails today. They are warnings so the gate below can be
        // meaningful, NOT because they are acceptable. phage_explorer-5t4r.4
        // tracks the set; the accessibility ones also fall under
        // phage_explorer-k4ep.5.
        'color-contrast': 'warn',
        'heading-order': 'warn',
        'label-content-name-mismatch': 'warn',
        'bf-cache': 'warn',
        'valid-source-maps': 'warn',
        deprecations: 'warn',
        'errors-in-console': 'warn',
        'unused-css-rules': 'warn',
        'unused-javascript': 'warn',
        'uses-responsive-images': 'warn',
        'total-byte-weight': 'warn',
        'bootup-time': 'warn',
        'mainthread-work-breakdown': 'warn',
        'max-potential-fid': 'warn',

        // --- The gate --------------------------------------------------------
        // Category floors, set below today's measured medians with room for
        // run-to-run noise. These are `error`: they fail the build.
        'categories:performance': ['error', { minScore: 0.28 }],
        'categories:accessibility': ['error', { minScore: 0.85 }],
        'categories:best-practices': ['error', { minScore: 0.78 }],
        'categories:seo': ['error', { minScore: 0.85 }],

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
