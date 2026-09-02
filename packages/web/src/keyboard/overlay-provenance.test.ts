import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ActionRegistryList } from './actionRegistry';
import { PROVENANCE_LEVELS } from '../components/overlays/primitives/OverlayProvenance';

/**
 * Provenance enforcement.
 *
 * An audit of all 46 analysis overlays found 10 that display fabricated or
 * hash-derived numbers with exactly the same visual authority as the 36 real
 * ones -- same menu, same category, same chrome. Two carried a green
 * "REAL DATA" banner over inputs that were a hash of the phage name.
 *
 * Fixing those ten individually leaves the eleventh free to ship unlabelled.
 * This test is the part that makes the class structurally impossible: every
 * overlay in the registry must declare where its numbers come from, so a new
 * overlay cannot reach the Analysis Menu without someone answering the
 * question.
 *
 * If you are here because this test failed on an overlay you just added: the
 * fix is to declare `provenance` on its registry entry, not to add it to the
 * chrome list. The chrome list is for surfaces that display no analysis
 * results at all.
 */

/**
 * Overlays that present no analysis results: navigation, reference tables,
 * settings, menus, and a dev-only benchmark. These make no claim about data,
 * so they have nothing to declare.
 */
const CHROME_OVERLAYS = new Set([
  'help',
  'search',
  'goto',
  'settings',
  'commandPalette',
  'analysisMenu',
  'simulationHub',
  'aaKey',
  'aaLegend',
  'gpuWasmBenchmark',
]);

const overlayActions = ActionRegistryList.filter(a => a.overlayId);

describe('overlay provenance is declared', () => {
  it('finds a meaningful number of overlays, so the checks are not vacuous', () => {
    expect(overlayActions.length).toBeGreaterThan(40);
  });

  it('every analysis overlay declares where its data comes from', () => {
    const undeclared = overlayActions
      .filter(a => !CHROME_OVERLAYS.has(a.overlayId!))
      .filter(a => !a.provenance)
      .map(a => a.overlayId!)
      .sort();
    expect(undeclared).toEqual([]);
  });

  it('every declared level is one the badge can render', () => {
    const invalid = overlayActions
      .filter(a => a.provenance && !PROVENANCE_LEVELS.includes(a.provenance))
      .map(a => `${a.overlayId}: ${a.provenance}`);
    expect(invalid).toEqual([]);
  });

  it('chrome surfaces do not claim a provenance they cannot have', () => {
    const overclaiming = overlayActions
      .filter(a => CHROME_OVERLAYS.has(a.overlayId!) && a.provenance)
      .map(a => a.overlayId!);
    expect(overclaiming).toEqual([]);
  });

  it('the check is discriminating', () => {
    // Guards the guard: if `provenance` were silently dropped from the type or
    // the registry, "no undeclared overlays" would pass over an empty set.
    const declared = overlayActions.filter(a => a.provenance);
    expect(declared.length).toBeGreaterThan(30);
  });
});

describe('the overlays the audit found fabricating data are labelled as such', () => {
  const levelOf = (id: string) =>
    overlayActions.find(a => a.overlayId === id)?.provenance;

  it('marks the remaining synthetic-input overlays as demo data', () => {
    // nicheNetwork analyses a randomly generated abundance table and never
    // receives the loaded phage. It is the last one left.
    expect(levelOf('nicheNetwork')).toBe('demo');
  });

  it('demotes crispr to heuristic now that its fake spacer set is gone', () => {
    // crispr scanned six hardcoded 6-mers and reported the chance matches as
    // spacer hits. That table is deleted. What remains is the anti-CRISPR
    // prediction, a rule-based estimate over this phage's own translated
    // genes, which is heuristic and not demo: the inputs are real.
    //
    // Spacer hits are now reported only when real spacer data is supplied, and
    // an exhaustive search of CRISPRCasdb against all 24 catalogue genomes
    // found none, so the overlay says which host's data is missing instead of
    // rendering zero pressure as a measurement.
    expect(levelOf('crispr')).toBe('heuristic');
  });

  it('promotes the two overlays whose fabrications were removed', () => {
    // phylodynamics built its tree from hashes of accession strings and now
    // fetches real sequences from NCBI; environmentalProvenance derived its
    // headline score from a hash of the phage name and now measures
    // catalogue distinctiveness with MinHash. Both are 'external' because
    // their primary data comes from a third-party service.
    //
    // This assertion is the reason the levels cannot quietly drift back: a
    // change that reintroduced synthesis without relabelling would leave the
    // registry claiming external data for a hash.
    expect(levelOf('phylodynamics')).toBe('external');
    expect(levelOf('environmentalProvenance')).toBe('external');
  });

  it('does not let a rule-based estimate pass as a measurement', () => {
    // Real inputs, but keyword and formula estimates rather than measurements.
    for (const id of ['defenseArmsRace', 'amgPathway', 'tropism', 'stability', 'pressure']) {
      expect(levelOf(id)).toBe('heuristic');
    }
  });

  it('marks genuinely computed overlays as measured', () => {
    for (const id of ['gcSkew', 'dotPlot', 'proteinDomains', 'codonBias', 'comparison']) {
      expect(levelOf(id)).toBe('measured');
    }
  });
});

/**
 * An overlay that can silently degrade must say so before it is opened.
 *
 * Two overlays fetch live data and fall back to synthetic data when the fetch
 * returns too little to analyse. The registry declared only the successful
 * case, so the Analysis Menu badged them "External data" unconditionally --
 * including in the case that happens most in practice: offline, rate-limited,
 * or a phage with too few dated records. The badge was wrong exactly when the
 * user most needed it to be right.
 *
 * The menu is drawn before the overlay opens, so the achieved provenance is
 * genuinely unknown at that point. The honest statement is the range, not
 * either endpoint.
 */
describe('overlays that degrade declare what they degrade to', () => {
  const OVERLAY_SOURCES: Record<string, string> = {
    phylodynamics: 'PhylodynamicsOverlay.tsx',
    environmentalProvenance: 'EnvironmentalProvenanceOverlay.tsx',
  };

  const entryFor = (overlayId: string) =>
    ActionRegistryList.find(a => a.overlayId === overlayId);

  it('declares a fallback for both overlays with a demo path', () => {
    for (const id of Object.keys(OVERLAY_SOURCES)) {
      expect(entryFor(id)?.provenanceFallback).toBe('demo');
    }
  });

  it('finds a real demo path in the source of each, so the rule is not vacuous', () => {
    // Guards the guard. If someone removed the demo fallback from an overlay,
    // the declaration above would become a lie in the other direction, and this
    // is what notices.
    for (const [id, file] of Object.entries(OVERLAY_SOURCES)) {
      const src = readFileSync(
        join(import.meta.dir, '../components/overlays', file),
        'utf8'
      );
      expect(src).toContain("setDataSource('demo')");
      expect(entryFor(id)).toBeDefined();
    }
  });

  it('does not declare a fallback for overlays that never degrade', () => {
    // A fallback on an overlay that cannot fall back would train users to
    // discount the badge, which is the same failure as not showing one.
    for (const id of ['gcSkew', 'dotPlot', 'proteinDomains', 'codonBias']) {
      expect(entryFor(id)?.provenanceFallback).toBeUndefined();
    }
  });

  it('never declares a fallback stronger than the primary level', () => {
    // A "fallback" that improves on the declared level is a contradiction and
    // means one of the two is wrong.
    const rank: Record<string, number> = {
      measured: 4,
      external: 3,
      simulated: 2,
      heuristic: 1,
      demo: 0,
    };
    for (const a of ActionRegistryList) {
      if (!a.provenanceFallback || !a.provenance) continue;
      expect(rank[a.provenanceFallback]).toBeLessThan(rank[a.provenance]);
    }
  });
});

/**
 * Provenance has to be visible BEFORE the overlay opens.
 *
 * The niche network carried an "EDUCATIONAL SIMULATION" banner in its body, but
 * its menu entry sat in the plain "Analysis" category beside forty overlays
 * that really do analyse the loaded genome. The user learned what it was only
 * after choosing it, which is the wrong order.
 */
describe('demo-driven overlays are not filed under plain Analysis', () => {
  it('keeps the simulated niche network out of the Analysis category', () => {
    const entry = ActionRegistryList.find(a => a.overlayId === 'nicheNetwork');
    expect(entry).toBeDefined();
    expect(entry!.category).not.toBe('Analysis');
    expect(entry!.category).toBe('Education');
  });

  it('leaves genuinely analytical overlays in Analysis', () => {
    // The discrimination check. Moving everything out of Analysis would satisfy
    // the assertion above and destroy the category's meaning.
    for (const id of ['gcSkew', 'dotPlot', 'proteinDomains', 'codonBias']) {
      expect(ActionRegistryList.find(a => a.overlayId === id)?.category).toBe('Analysis');
    }
  });

  it('has no overlay left in Analysis whose provenance is demo', () => {
    // The general form of the rule, so the next demo overlay cannot land in
    // Analysis unnoticed.
    const offenders = ActionRegistryList.filter(
      a => a.overlayId && a.category === 'Analysis' && a.provenance === 'demo'
    ).map(a => a.overlayId);
    expect(offenders).toEqual([]);
  });
});

/**
 * The badge reaches every overlay without any overlay opting in.
 *
 * Applying it by editing forty-six overlay components would have labelled the
 * forty-six that exist today and done nothing for the forty-seventh. The shared
 * `Overlay` chrome reads the level from the registry instead, so a new overlay
 * is labelled the moment it is registered -- and the registry already refuses
 * an entry without a level.
 *
 * These are source-level assertions because what is being checked is that the
 * wiring exists in one place, which no rendering test of a single overlay can
 * establish.
 */
describe('the badge is wired once, in shared chrome', () => {
  const read = (rel: string) => readFileSync(join(import.meta.dir, '..', rel), 'utf8');

  it('renders the badge from the shared Overlay component', () => {
    const src = read('components/overlays/Overlay.tsx');
    expect(src).toContain('OverlayProvenance');
    expect(src).toContain('provenanceForOverlay');
    // Reads the registry rather than taking a prop, so no caller can forget.
    expect(src).toContain('ActionRegistryList');
  });

  it('does not badge measured overlays', () => {
    // A badge on every panel is a badge nobody reads. The signal has to be
    // reserved for levels that need it.
    const src = read('components/overlays/Overlay.tsx');
    expect(src).toContain("provenance !== 'measured'");
  });

  it('shows the level in the Command Palette as well as the Analysis Menu', () => {
    // Two entry points reach the same overlay. Labelling one and not the other
    // means half the users see the warning.
    for (const rel of [
      'components/overlays/CommandPalette.tsx',
      'components/overlays/AnalysisMenu.tsx',
    ]) {
      const src = read(rel);
      expect(src).toContain('OverlayProvenance');
      expect(src).toContain("!== 'measured'");
    }
  });

  it('has a TUI equivalent using the same level names', () => {
    // Two surfaces disagreeing about what a level means would be worse than
    // neither having one.
    const src = readFileSync(
      join(import.meta.dir, '../../../tui/src/components/OverlayProvenance.tsx'),
      'utf8'
    );
    for (const level of PROVENANCE_LEVELS) {
      expect(src).toContain(level);
    }
  });

  it('documents the system for whoever adds overlay 47', () => {
    const doc = readFileSync(
      join(import.meta.dir, '../../../../docs/overlay-design-system.md'),
      'utf8'
    );
    expect(doc).toContain('Provenance');
    expect(doc).toContain('provenanceFallback');
    // The load-bearing instruction: declare it in the registry, do not add the
    // badge yourself.
    expect(doc).toContain('You do not add the badge to your overlay');
  });
});

/**
 * The in-app primer must only teach shortcuts that exist.
 *
 * `KeyboardPrimer.tsx` is shown to new users from the welcome modal, and it
 * taught `g g` (go to start), `G` (go to end) and `Space` (toggle DNA/amino).
 * None of the three was bound. That is worse than ordinary documentation drift:
 * it is the first thing a new user reads, it is inside the product rather than
 * in a file they might never open, and it means a newcomer's first three
 * attempts to use the app fail silently.
 *
 * All three are now bound. This test is what stops them coming apart again.
 */
describe('the keyboard primer teaches only real shortcuts', () => {
  const primer = readFileSync(
    join(import.meta.dir, '../components/overlays/KeyboardPrimer.tsx'),
    'utf8'
  );

  /** Every combo the registry binds, flattened and normalised for lookup. */
  const boundKeys = (): Set<string> => {
    const out = new Set<string>();
    for (const a of ActionRegistryList) {
      const combos = Array.isArray(a.defaultShortcut)
        ? a.defaultShortcut
        : a.defaultShortcut
          ? [a.defaultShortcut]
          : [];
      for (const c of combos) {
        if ('sequence' in c) out.add(c.sequence.join('').toLowerCase());
        else out.add(String(c.key).toLowerCase());
      }
    }
    return out;
  };

  it('reads the primer source', () => {
    expect(primer).toContain('KeyboardPrimer');
    expect(primer.length).toBeGreaterThan(500);
  });

  it('binds the vim motions the primer teaches', () => {
    const bound = boundKeys();
    // gg and G are the idiomatic vim motions the primer shows, and the app is
    // vim-inspired by design, so the primer was right and the bindings missing.
    expect(bound.has('gg')).toBe(true);
    expect(bound.has('g')).toBe(true); // Shift+G normalises to 'g'
  });

  it('binds Space for the view-mode toggle the primer teaches', () => {
    expect(boundKeys().has(' ')).toBe(true);
  });

  it('teaches every key it shows, and shows only keys that are bound', () => {
    // Extract the primer's own `keys: [...]` arrays and check each against the
    // registry. Arrow keys and modifier names are display-only and excluded.
    // Arrow glyphs and modifier names are display-only: the registry stores
    // them as 'ArrowUp' and as modifier flags, not as these characters.
    const display = new Set(['↑', '↓', '←', '→', 'esc', 'shift', 'ctrl', 'alt']);
    // Names the primer spells out that the registry stores as the character.
    const alias: Record<string, string> = { space: ' ', enter: 'enter', tab: 'tab' };
    const normalise = (k: string) => alias[k.toLowerCase()] ?? k.toLowerCase();

    const bound = boundKeys();
    const unbound: string[] = [];

    for (const m of primer.matchAll(/keys:\s*\[([^\]]+)\]/g)) {
      const parts = [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
      if (parts.length === 0) continue;

      const meaningful = parts.filter(p => !display.has(p.toLowerCase()));
      if (meaningful.length === 0) continue; // pure display row, e.g. ['↑','↓']

      // A multi-entry array of single characters is a sequence (['g','g']);
      // anything else is one key per entry.
      const isSequence =
        meaningful.length > 1 && meaningful.every(p => p.length === 1);

      const candidates = isSequence
        ? [meaningful.join('').toLowerCase()]
        : meaningful.map(normalise);

      for (const c of candidates) if (!bound.has(c)) unbound.push(c);
    }

    expect(unbound).toEqual([]);
  });

  it('that check can fail', () => {
    // Guards the guard: the primer must actually contain key arrays, or the
    // filter above is testing an empty list.
    const arrays = [...primer.matchAll(/keys:\s*\[([^\]]+)\]/g)];
    expect(arrays.length).toBeGreaterThan(5);
    expect(boundKeys().has('this-is-not-a-key')).toBe(false);
  });
});

/**
 * There is one key map, and featureRegistry is not it.
 *
 * `packages/web/src/lib/featureRegistry.ts` carried a `shortcuts?: string[]` on
 * every entry -- a second, hand-maintained copy of the key map. Roughly
 * eighteen of the fifty-two were wrong: k-mer anomaly listed `V` against the
 * real Alt+J, HGT listed `Y` against Alt+H, dot plot listed `.` against Alt+O,
 * and diff listed `d` when nothing registered it at all.
 *
 * The file is also dead: its only importer is `FullFeatureModal`, which is
 * exported from the controls barrel and rendered nowhere. That is worth stating
 * plainly rather than leaving for the next reader to discover.
 */
describe('featureRegistry does not carry a second key map', () => {
  const registry = readFileSync(
    join(import.meta.dir, '../lib/featureRegistry.ts'),
    'utf8'
  );

  it('reads the file', () => {
    expect(registry).toContain('FeatureCategory');
    expect(registry.length).toBeGreaterThan(5000);
  });

  it('declares no shortcuts on feature entries', () => {
    // Comments explaining the removal are allowed to mention the field; a live
    // declaration is not.
    const code = registry
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/shortcuts\s*[?]?:/);
    expect(code).not.toMatch(/shortcuts:\s*\[/);
  });

  it('that check can fail', () => {
    // Guards the guard: the stripped source must still contain the entries, or
    // the assertion above is testing an empty string.
    const code = registry.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toContain('analysis:kmer-anomaly');
    expect(code).toContain("category: 'analysis'");
  });
});
