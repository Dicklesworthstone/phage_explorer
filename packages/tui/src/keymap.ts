/**
 * The TUI's key bindings, as data.
 *
 * ## Why this exists
 *
 * `docs/keyboard-shortcuts.md` called itself "the single-source key map for the
 * TUI and the upcoming web UI" and matched neither. Twenty-odd documented keys
 * were not bound in the web app, the web app's entire Alt and Ctrl+Shift layer
 * was documented nowhere, five TUI bindings were undocumented, and the TUI's own
 * help overlay advertised two shortcuts that do not exist.
 *
 * That is what a hand-maintained key map becomes. The web app already had a
 * machine-readable registry; the TUI did not, so there was nothing to generate
 * the TUI half of the document from. This is that missing half.
 *
 * ## What this is and is not
 *
 * It is NOT the dispatcher. `App.tsx` still routes keys itself, and rewriting a
 * 46 KB input handler to consume this table would be a large, risky change to
 * make for a documentation fix.
 *
 * Instead the two are held together mechanically: `keymap.test.ts` asserts that
 * every entry here is reachable in the handler AND that every key branch in the
 * handler has an entry here. Neither can drift without failing the build, which
 * is the property "single source of truth" was claiming and did not have.
 *
 * If you add a key to `App.tsx`, add it here. The test will tell you.
 */

/** A tier the user has to reach before a binding does anything. */
export type TuiTier = 'novice' | 'intermediate' | 'power';

export interface TuiBinding {
  /** Every literal `input` value that triggers this action. */
  keys: readonly string[];
  /** How the binding is written for a human, e.g. "Ctrl+F" or "g / G". */
  display: string;
  /** What it does, in the user's terms. */
  action: string;
  /** Grouping for the generated document. */
  category: 'Navigation' | 'View' | 'Analysis' | 'Overlays' | 'System';
  /** Minimum experience tier, where the handler gates on one. */
  tier?: TuiTier;
  /**
   * A string that must appear in `App.tsx` for this binding to be considered
   * wired. Usually the overlay constant or the function the branch calls.
   */
  handler: string;
}

export const TUI_KEYMAP: readonly TuiBinding[] = [
  // --- Navigation -----------------------------------------------------------
  // Escape sequences are stored exactly as the handler spells them, so the
  // consistency test can look for the same literal rather than rebuilding it.
  { keys: ['\\x1b[H', '\\x1b[1~', '\\x1bOH'], display: 'Home', action: 'Jump to sequence start', category: 'Navigation', handler: 'scrollToStart' },
  { keys: ['\\x1b[F', '\\x1b[4~', '\\x1bOF'], display: 'End', action: 'Jump to sequence end', category: 'Navigation', handler: 'scrollToEnd' },
  { keys: ['['], display: '[', action: 'Jump to previous gene start', category: 'Navigation', handler: 'findPreviousGenePosition' },
  { keys: [']'], display: ']', action: 'Jump to next gene start', category: 'Navigation', handler: 'findNextGenePosition' },

  // --- View -----------------------------------------------------------------
  { keys: ['n', 'N', 'c', 'C', ' '], display: 'n / c / Space', action: 'Cycle DNA / dual / amino-acid view', category: 'View', handler: 'toggleViewMode' },
  { keys: ['f', 'F'], display: 'f', action: 'Cycle reading frame', category: 'View', handler: 'cycleReadingFrame' },
  { keys: ['t', 'T'], display: 't', action: 'Cycle colour theme', category: 'View', handler: 'cycleTheme' },
  { keys: ['d', 'D'], display: 'd', action: 'Toggle diff view', category: 'View', handler: 'toggleDiff' },
  { keys: ['m', 'M'], display: 'm', action: 'Toggle 3D model', category: 'View', handler: 'toggle3DModel' },
  { keys: ['z', 'Z'], display: 'z', action: 'Toggle 3D fullscreen', category: 'View', handler: 'toggle3DModelFullscreen' },

  // --- Analysis overlays ----------------------------------------------------
  { keys: ['g', 'G'], display: 'g', action: 'GC skew', category: 'Analysis', tier: 'intermediate', handler: 'GC_SKEW_ID' },
  { keys: ['y', 'Y'], display: 'y', action: 'Transcription flow', category: 'Analysis', tier: 'intermediate', handler: 'TRANSCRIPTION_ID' },
  { keys: ['v', 'V'], display: 'v', action: 'Packaging pressure gauge', category: 'Analysis', tier: 'intermediate', handler: 'PRESSURE_ID' },
  { keys: ['j', 'J'], display: 'j', action: 'K-mer anomaly', category: 'Analysis', tier: 'intermediate', handler: 'KMER_ID' },
  { keys: ['l', 'L'], display: 'l', action: 'Module coherence', category: 'Analysis', tier: 'intermediate', handler: 'MODULES_ID' },
  { keys: ['h', 'H'], display: 'h', action: 'Horizontal gene transfer', category: 'Analysis', tier: 'intermediate', handler: 'HGT_ID' },
  { keys: ['u', 'U'], display: 'u', action: 'Structure constraints', category: 'Analysis', tier: 'intermediate', handler: 'STRUCTURE_ID' },
  { keys: ['b', 'B'], display: 'b', action: 'DNA bendability', category: 'Analysis', tier: 'intermediate', handler: 'BENDABILITY_ID' },
  { keys: ['p', 'P'], display: 'p', action: 'Promoter prediction', category: 'Analysis', tier: 'intermediate', handler: 'PROMOTER_ID' },
  { keys: ['r', 'R'], display: 'r', action: 'Repeat finder', category: 'Analysis', tier: 'intermediate', handler: 'REPEAT_ID' },
  { keys: ['i', 'I'], display: 'i', action: 'CRISPR pressure', category: 'Analysis', tier: 'intermediate', handler: 'CRISPR_ID' },
  { keys: ['e', 'E'], display: 'e', action: 'Tail fibre tropism', category: 'Analysis', tier: 'intermediate', handler: 'TROPISM_ID' },
  { keys: ['x', 'X'], display: 'x', action: 'Sequence complexity', category: 'Analysis', tier: 'intermediate', handler: 'COMPLEXITY_ID' },
  { keys: ['a', 'A'], display: 'a', action: 'Analysis menu', category: 'Analysis', tier: 'intermediate', handler: 'ANALYSIS_MENU_ID' },

  // --- Modifier-bearing bindings -------------------------------------------
  // These live in the modifier table in App.tsx, dispatched before the
  // plain-letter chain. Before that table existed, three of them were shadowed
  // by earlier single-letter branches and did nothing.
  { keys: ['A'], display: 'Shift+A', action: 'Anomaly detection', category: 'Analysis', tier: 'power', handler: 'ANOMALY_ID' },
  { keys: ['G'], display: 'Shift+G', action: 'Non-B DNA structures', category: 'Analysis', tier: 'intermediate', handler: 'NONB_ID' },
  { keys: ['P'], display: 'Shift+P', action: 'Phase portraits', category: 'Analysis', tier: 'intermediate', handler: "'phasePortrait'" },
  { keys: ['Y'], display: 'Shift+Y', action: 'Synteny alignment', category: 'Analysis', tier: 'intermediate', handler: 'SYNTENY_ID' },
  { keys: ['S'], display: 'Shift+S', action: 'Simulation hub', category: 'Analysis', tier: 'power', handler: 'SIMULATION_MENU_ID' },
  { keys: ['f', 'F'], display: 'Ctrl+F', action: 'Fold quickview', category: 'Analysis', tier: 'power', handler: "'foldQuickview'" },
  { keys: ['p', 'P'], display: 'Ctrl+P', action: 'Command palette', category: 'System', tier: 'power', handler: "'commandPalette'" },

  // --- 3D fullscreen mode ---------------------------------------------------
  // Active only while the 3D model is fullscreen; the handler returns early in
  // that mode, so these shadow the bindings above rather than coexisting.
  // Documented because a key that does something different depending on mode is
  // exactly what a user needs told.
  { keys: ['o', 'O'], display: 'o / p (3D fullscreen)', action: 'Pause or resume the 3D animation', category: 'View', handler: 'toggle3DModelPause' },

  // --- System ---------------------------------------------------------------
  { keys: ['q', 'Q'], display: 'q', action: 'Quit (press twice to confirm)', category: 'System', handler: 'quitConfirmPending' },
  { keys: ['?'], display: '?', action: 'Help overlay', category: 'System', handler: "'help'" },
  { keys: ['k', 'K'], display: 'k', action: 'Amino-acid key', category: 'System', handler: "'aaKey'" },
  { keys: ['s', '/'], display: 's / /', action: 'Search', category: 'System', handler: "'search'" },
  { keys: ['w', 'W'], display: 'w', action: 'Comparison view', category: 'System', handler: 'openComparison' },
  { keys: [':'], display: ':', action: 'Command palette', category: 'System', tier: 'power', handler: "'commandPalette'" },
];

/**
 * F-key bindings, which the handler resolves from escape sequences before the
 * rest of the chain runs.
 */
export const TUI_FUNCTION_KEYS: readonly TuiBinding[] = [
  { keys: ['F1'], display: 'F1', action: 'Help overlay', category: 'System', handler: "fKey === 'F1'" },
  { keys: ['F2'], display: 'F2', action: 'Search', category: 'System', handler: "fKey === 'F2'" },
  { keys: ['F3'], display: 'F3', action: 'Comparison view', category: 'System', handler: "fKey === 'F3'" },
  { keys: ['F4'], display: 'F4', action: 'Toggle diff', category: 'View', handler: "fKey === 'F4'" },
  { keys: ['F5'], display: 'F5', action: 'Toggle 3D model', category: 'View', handler: "fKey === 'F5'" },
  { keys: ['F6'], display: 'F6', action: 'Cycle theme', category: 'View', handler: "fKey === 'F6'" },
  { keys: ['F7'], display: 'F7', action: 'Cycle reading frame', category: 'View', handler: "fKey === 'F7'" },
  { keys: ['F8'], display: 'F8', action: 'Cycle view mode', category: 'View', handler: "fKey === 'F8'" },
  { keys: ['F9'], display: 'F9', action: 'GC skew', category: 'Analysis', handler: "fKey === 'F9'" },
  { keys: ['F10'], display: 'F10', action: 'Analysis menu', category: 'Analysis', handler: "fKey === 'F10'" },
];

/**
 * Where the TUI and the web app deliberately differ, and why.
 *
 * The bead that prompted this asked for divergences to be recorded rather than
 * inferred. Some are forced: the web app runs in a browser, and the project's
 * own validator flags several combinations as reserved by the browser
 * (`packages/web/src/keyboard/validateConflicts.ts`). Others are consequences
 * of the terminal having no modifier-free namespace to spare.
 *
 * A divergence not listed here is drift, not design.
 */
export interface KeyDivergence {
  action: string;
  tui: string;
  web: string;
  reason: string;
}

export const TUI_WEB_DIVERGENCES: readonly KeyDivergence[] = [
  {
    action: 'Command palette',
    tui: ': or Ctrl+P',
    web: 'Ctrl/Cmd+K',
    reason:
      'Ctrl+P is the browser print dialog and cannot be intercepted reliably; ' +
      'validateConflicts.ts flags it as reserved. Ctrl+K is the de facto web ' +
      'convention. The TUI has no such constraint and keeps the vim-style colon.',
  },
  {
    action: 'Search',
    tui: 's or /',
    web: '/',
    reason:
      'The web app reserves plain letters for overlay shortcuts on the Alt ' +
      'layer and keeps only the vim-style slash. The TUI has spare single ' +
      'letters and offers both.',
  },
  {
    action: 'Comparison view',
    tui: 'w',
    web: 'c',
    reason:
      'The TUI uses c for the DNA/amino-acid view cycle, so comparison took w. ' +
      'The web app cycles views with a toolbar control and leaves c free.',
  },
  {
    action: 'Analysis overlays',
    tui: 'plain letters (g, y, v, j, h, ...)',
    web: 'Alt layer (Alt+G, Alt+Y, ...)',
    reason:
      'A browser page shares its single-letter namespace with find-as-you-type ' +
      'and with any focused input. The terminal does not, so the TUI can spend ' +
      'plain letters where the web app has to reach for a modifier.',
  },
  {
    action: 'Function keys',
    tui: 'F1-F10 bound',
    web: 'not bound',
    reason:
      'F-keys are claimed by the browser and the OS (F1 help, F3 find next, ' +
      'F5 reload, F11 fullscreen, F12 devtools). The TUI binds F1-F10 because a ' +
      'terminal receives them as ordinary escape sequences. F11 is left alone in ' +
      'both, and F12 is bound in neither.',
  },
];
