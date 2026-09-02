import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Overlay wiring guard.
 *
 * The TUI gates its global key handler on `{ isActive: !activeOverlay }`, so
 * whenever an overlay is open the only component listening for Escape is the
 * overlay itself. That makes an overlay id you can OPEN but which has no
 * render branch an unrecoverable input lock: the store records an active
 * overlay, nothing mounts, and no handler is left to close it. The user has
 * to kill the process.
 *
 * That is not hypothetical. `Shift+A` bound `openOverlay('anomaly')` while
 * App.tsx had no `activeOverlay === 'anomaly'` branch, so the documented
 * anomaly-scanner shortcut froze the app.
 *
 * A hand-maintained list of "overlays that render" would drift the same way
 * the binding did, so this reads App.tsx directly: every overlay opened must
 * be an overlay rendered. It is a source-level check because App.tsx is
 * inseparable from Ink and a real terminal.
 */

const APP_SOURCE = readFileSync(join(import.meta.dir, 'App.tsx'), 'utf8');

/** Resolve `const FOO_ID: OverlayId = 'foo';` declarations to their values. */
function overlayIdConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>();
  const re = /const\s+([A-Z0-9_]+)\s*:\s*OverlayId\s*=\s*'([^']+)'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    constants.set(match[1], match[2]);
  }
  return constants;
}

function resolve(token: string, constants: Map<string, string>): string | null {
  const quoted = token.match(/^'([^']+)'$/);
  if (quoted) return quoted[1];
  return constants.get(token) ?? null;
}

/** Overlay ids the key handlers and menus can open. */
export function openedOverlayIds(source: string): Set<string> {
  const ids = new Set<string>();
  const constants = overlayIdConstants(source);
  const re = /(?:openOverlay|toggleOverlay)\(\s*((?:'[^']+')|(?:[A-Z0-9_]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const id = resolve(match[1], constants);
    if (id) ids.add(id);
  }
  return ids;
}

/** Overlay ids that have an `activeOverlay === X` render branch. */
export function renderedOverlayIds(source: string): Set<string> {
  const ids = new Set<string>();
  const constants = overlayIdConstants(source);
  const re = /activeOverlay\s*===\s*((?:'[^']+')|(?:[A-Z0-9_]+))/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const id = resolve(match[1], constants);
    if (id) ids.add(id);
  }
  return ids;
}

describe('TUI overlay wiring', () => {
  const opened = openedOverlayIds(APP_SOURCE);
  const rendered = renderedOverlayIds(APP_SOURCE);

  it('parses a meaningful number of overlays from App.tsx', () => {
    // Guards the guard: if the regexes ever stop matching, the parity test
    // below would pass vacuously over two empty sets.
    expect(overlayIdConstants(APP_SOURCE).size).toBeGreaterThan(10);
    expect(opened.size).toBeGreaterThan(10);
    expect(rendered.size).toBeGreaterThan(10);
  });

  it('every overlay that can be opened also has a render branch', () => {
    const missing = [...opened].filter(id => !rendered.has(id)).sort();
    expect(missing).toEqual([]);
  });

  it('renders the anomaly overlay that Shift+A opens', () => {
    // The specific regression: bound, documented, never rendered, locked input.
    expect(opened.has('anomaly')).toBe(true);
    expect(rendered.has('anomaly')).toBe(true);
  });

  it('keeps the global input handler gated on an active overlay', () => {
    // If this gate is ever removed the lock class disappears, and this whole
    // test file can go with it. While it stands, the parity test is load-bearing.
    expect(APP_SOURCE).toContain('{ isActive: !activeOverlay }');
  });
});

describe('overlay wiring guard catches the defect it exists for', () => {
  // The pre-fix shape of App.tsx, reduced to the parts that matter: a bound
  // overlay with no render branch, alongside one that is wired correctly.
  const BROKEN_SOURCE = `
    const ANOMALY_ID: OverlayId = 'anomaly';
    const KMER_ID: OverlayId = 'kmerAnomaly';
    if (key.shift) { openOverlay(ANOMALY_ID); }
    toggleOverlay(KMER_ID);
    return <>{activeOverlay === KMER_ID && <KmerAnomalyOverlay />}</>;
  `;

  it('flags an overlay that is opened but never rendered', () => {
    const opened = openedOverlayIds(BROKEN_SOURCE);
    const rendered = renderedOverlayIds(BROKEN_SOURCE);
    const missing = [...opened].filter(id => !rendered.has(id));
    expect(missing).toEqual(['anomaly']);
  });

  it('passes once the missing render branch is added', () => {
    const fixed = BROKEN_SOURCE.replace(
      '{activeOverlay === KMER_ID && <KmerAnomalyOverlay />}',
      '{activeOverlay === KMER_ID && <KmerAnomalyOverlay />}{activeOverlay === ANOMALY_ID && <AnomalyOverlay />}'
    );
    const opened = openedOverlayIds(fixed);
    const rendered = renderedOverlayIds(fixed);
    expect([...opened].filter(id => !rendered.has(id))).toEqual([]);
  });
});
