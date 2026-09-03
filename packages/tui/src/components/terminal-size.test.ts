import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { clampOverlayWidth, MIN_COLUMNS, MIN_ROWS } from './terminal-size';

/**
 * The TUI must not fall apart in a narrow window.
 *
 * `phage_explorer-2rdn`'s definition of done: "The TUI renders something usable,
 * or a clear message, at any terminal size, and never exits with an unhandled
 * exception."
 *
 * There was no width or height guard anywhere in packages/tui/src -- no
 * `columns <`, no `rows <`, no message. Overlays hardcode widths between 68 and
 * 92 columns with `borderStyle="double"`, so in a split pane or a tmux sidebar
 * the layout degraded into unreadable wrapping with no explanation, while the
 * README's troubleshooting table promised:
 *
 *     Terminal too small -> Resize to at least 80x24 for best experience
 *
 * I closed that epic once on the strength of its children being closed, without
 * checking its own criterion. These tests exist so that cannot happen silently
 * again: they assert the behaviour, not the presence of a file.
 */

describe('clampOverlayWidth', () => {
  it('leaves a designed width alone when it fits', () => {
    expect(clampOverlayWidth(68, 120)).toBe(68);
  });

  it('shrinks a width that would overflow the terminal', () => {
    // The specific failure: a 92-wide bordered box at exactly the 80-column
    // floor the README promises works.
    expect(clampOverlayWidth(92, 80)).toBe(78);
    expect(clampOverlayWidth(92, 80)).toBeLessThan(80);
  });

  it('leaves room for the border characters', () => {
    // A box exactly as wide as the terminal has nowhere to draw its border.
    for (const columns of [40, 80, 100]) {
      expect(clampOverlayWidth(200, columns)).toBeLessThan(columns);
    }
  });

  it('never returns a width too small to render into', () => {
    expect(clampOverlayWidth(92, 10)).toBeGreaterThanOrEqual(20);
    expect(clampOverlayWidth(92, 0)).toBeGreaterThanOrEqual(20);
  });

  it('assumes the floor when the size is unknown', () => {
    // stdout.columns is undefined for a pipe or a test harness. Assuming the
    // documented minimum is safer than assuming infinite width.
    expect(clampOverlayWidth(92, undefined)).toBe(MIN_COLUMNS - 2);
  });

  it('is discriminating', () => {
    // Guards the guard: a function returning its input would pass the first
    // test and none of the others.
    expect(clampOverlayWidth(92, 80)).not.toBe(92);
  });
});

describe('the size gate is wired and states the documented floor', () => {
  const gate = readFileSync(join(import.meta.dir, 'terminal-size.tsx'), 'utf8');
  const entry = readFileSync(join(import.meta.dir, '../index.tsx'), 'utf8');

  it('uses the floor the README documents rather than an invented one', () => {
    expect(MIN_COLUMNS).toBe(80);
    expect(MIN_ROWS).toBe(24);
    const readme = readFileSync(join(import.meta.dir, '../../../../README.md'), 'utf8');
    expect(readme).toContain('80x24');
  });

  it('wraps the app, so the guard cannot be bypassed by mounting App directly', () => {
    expect(entry).toContain('TerminalSizeGate');
    expect(entry).toMatch(/<TerminalSizeGate>[\s\S]*<App[\s\S]*<\/TerminalSizeGate>/);
  });

  it('tells the user the actual size and the required size', () => {
    // "Terminal too small" alone leaves the user guessing how much to resize.
    expect(gate).toContain('Terminal too small');
    expect(gate).toContain('{columns}x{rows}');
    expect(gate).toContain('{MIN_COLUMNS}x{MIN_ROWS}');
  });

  it('does not block when the size is unknowable', () => {
    // Piping the TUI, or running it under a test harness, gives no columns.
    // Refusing to render there would break every non-TTY use for no benefit:
    // there is no user present to resize anything.
    expect(gate).toContain('typeof columns');
    expect(gate).toContain('known &&');
  });
});

describe('no overlay declares a width the floor cannot show', () => {
  const dir = import.meta.dir;
  const overlays = readdirSync(dir).filter(f => f.endsWith('.tsx'));

  it('finds the overlay sources, so this is not vacuous', () => {
    expect(overlays.length).toBeGreaterThan(20);
  });

  it('has no hardcoded width above the 80-column floor', () => {
    // Every width over 80 must go through useOverlayWidth. A literal one is a
    // box that cannot fit at the size the README promises works.
    const offenders: string[] = [];
    for (const file of overlays) {
      const src = readFileSync(join(dir, file), 'utf8');
      for (const m of src.matchAll(/width=\{(\d{2,3})\}/g)) {
        if (Number(m[1]) > MIN_COLUMNS) offenders.push(`${file}: width={${m[1]}}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the wide overlays route through the clamping hook', () => {
    const clamped = overlays.filter(f =>
      readFileSync(join(dir, f), 'utf8').includes('useOverlayWidth(')
    );
    expect(clamped.length).toBeGreaterThanOrEqual(7);
  });
});
