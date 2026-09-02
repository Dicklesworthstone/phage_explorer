import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TUI_KEYMAP, TUI_FUNCTION_KEYS, TUI_WEB_DIVERGENCES } from './keymap';

/**
 * The keymap and the handler must not drift apart.
 *
 * `docs/keyboard-shortcuts.md` called itself "the single-source key map for the
 * TUI and the upcoming web UI" and matched neither surface. A second list
 * maintained by hand always ends up there; the only thing that prevents it is a
 * check that fails.
 *
 * `keymap.ts` is not the dispatcher -- App.tsx still routes keys itself, and
 * rewriting a 46 KB input handler for a documentation fix would be a large,
 * risky change. So the two are held together mechanically instead, in BOTH
 * directions. One direction alone is not enough:
 *
 *   - entries without handlers  -> the document promises keys that do nothing
 *   - handlers without entries  -> the document omits keys that work
 *
 * Both happened. Five TUI bindings were undocumented, and the TUI's own help
 * overlay advertised two shortcuts that were never bound.
 */

const APP = readFileSync(join(import.meta.dir, 'components/App.tsx'), 'utf8');
const HANDLER = APP.slice(APP.indexOf('useInput((input, key) => {'));

/** Every literal `input === '<key>'` the handler tests, single characters only. */
function handlerKeys(): Set<string> {
  const keys = new Set<string>();
  for (const m of HANDLER.matchAll(/input === '([^']+)'/g)) {
    if (m[1].length <= 2 && !m[1].startsWith('\\x1b')) keys.add(m[1]);
  }
  return keys;
}

/** Every key named in the modifier table. */
function modifierTableKeys(): Set<string> {
  const start = HANDLER.indexOf('const modifierBindings');
  const end = HANDLER.indexOf('matchModifierBinding(modifierBindings');
  const table = HANDLER.slice(start, end);
  const keys = new Set<string>();
  for (const m of table.matchAll(/'([^'])'/g)) keys.add(m[1]);
  return keys;
}

describe('the keymap is not vacuous', () => {
  it('reads the handler source', () => {
    expect(APP.length).toBeGreaterThan(10000);
    expect(HANDLER.length).toBeGreaterThan(1000);
  });

  it('has entries', () => {
    expect(TUI_KEYMAP.length).toBeGreaterThan(20);
    expect(TUI_FUNCTION_KEYS.length).toBe(10);
  });
});

describe('every keymap entry is actually wired', () => {
  it('names a handler string that appears in App.tsx', () => {
    // Catches the failure the TUI help overlay had: advertising `Ctrl+K` for the
    // palette when Ctrl+K is not bound anywhere, and `Alt+R` for repeats when
    // the binding is plain `R`.
    const missing = [...TUI_KEYMAP, ...TUI_FUNCTION_KEYS]
      .filter(b => !APP.includes(b.handler))
      .map(b => `${b.display} -> ${b.handler}`);
    expect(missing).toEqual([]);
  });

  it('uses keys the handler or the modifier table actually tests', () => {
    // Uniform over the source form, so escape sequences are checked the same way
    // as letters: a key is reachable if the handler compares `input` to that
    // exact literal, or the modifier table lists it.
    const inTable = modifierTableKeys();

    const unreachable: string[] = [];
    for (const b of TUI_KEYMAP) {
      const reachable = b.keys.some(
        k => HANDLER.includes(`input === '${k}'`) || inTable.has(k)
      );
      if (!reachable) unreachable.push(`${b.display} (${b.keys.join(', ')})`);
    }
    expect(unreachable).toEqual([]);
  });
});

describe('every wired key is documented', () => {
  it('has a keymap entry for every single-character branch in the handler', () => {
    // The other direction. Without it, `u` (structure constraints), `i`
    // (CRISPR), Shift+G, Shift+A and Shift+Y stay bound and undocumented, which
    // is exactly what the audit found.
    const documented = new Set<string>();
    for (const b of TUI_KEYMAP) for (const k of b.keys) documented.add(k);

    const undocumented = [...handlerKeys()].filter(k => !documented.has(k));
    expect(undocumented).toEqual([]);
  });

  it('has a keymap entry for every key in the modifier table', () => {
    const documented = new Set<string>();
    for (const b of TUI_KEYMAP) for (const k of b.keys) documented.add(k);

    const undocumented = [...modifierTableKeys()].filter(k => !documented.has(k));
    expect(undocumented).toEqual([]);
  });

  it('has an entry for every F-key the handler resolves', () => {
    const bound = [...APP.matchAll(/fKey === '(F\d+)'/g)].map(m => m[1]);
    const documented = new Set(TUI_FUNCTION_KEYS.flatMap(b => b.keys));
    expect([...new Set(bound)].filter(f => !documented.has(f))).toEqual([]);
  });
});

describe('the checks above can fail', () => {
  it('would reject an entry whose handler is absent', () => {
    // Guards the guard. If `APP.includes` matched anything, the wiring check
    // would pass for a keymap full of nonsense.
    expect(APP.includes('THIS_OVERLAY_DOES_NOT_EXIST_ID')).toBe(false);
  });

  it('would reject a handler key that no entry covers', () => {
    // The two sets must track each other, so a key absent from the handler must
    // also be absent from the keymap. '9' is bound in neither.
    //
    // This assertion previously used 'q' as its example of an unbound key. 'q'
    // is the quit binding, and the undocumented check caught it -- which is the
    // check working, and worth recording: writing this file surfaced two live
    // undocumented bindings, 'q' (quit) and 'o' (3D pause), that the original
    // audit had also missed.
    const documented = new Set(TUI_KEYMAP.flatMap(b => b.keys));
    expect(handlerKeys().has('9')).toBe(false);
    expect(documented.has('9')).toBe(false);
    expect(handlerKeys().size).toBeGreaterThan(10);
    expect(documented.size).toBeGreaterThan(handlerKeys().size);
  });
});

describe('divergences from the web app are recorded, not inferred', () => {
  it('gives every divergence a reason', () => {
    expect(TUI_WEB_DIVERGENCES.length).toBeGreaterThan(0);
    for (const d of TUI_WEB_DIVERGENCES) {
      expect(d.reason.length).toBeGreaterThan(40);
      expect(d.tui.length).toBeGreaterThan(0);
      expect(d.web.length).toBeGreaterThan(0);
    }
  });

  it('records the browser-reserved combinations the validator already flags', () => {
    // The audit noted that some web/TUI divergence is forced by the browser and
    // that the reason should be written down rather than left to be inferred.
    const all = TUI_WEB_DIVERGENCES.map(d => d.reason).join(' ');
    expect(all).toContain('validateConflicts');
    expect(all).toMatch(/browser/i);
  });
});

/**
 * The TUI's own help overlay must not advertise keys that do not exist.
 *
 * It advertised `Ctrl+K` for the command palette -- Ctrl+K is bound nowhere in
 * the TUI, the palette is `:` or Ctrl+P -- and `Alt+R` for repeats, where the
 * binding is plain `r`. A help screen that is wrong is worse than none: the user
 * has no way to tell it from a bug in the app.
 */
describe('the help overlay agrees with the keymap', () => {
  const HELP = readFileSync(
    join(import.meta.dir, 'components/HelpOverlay.tsx'),
    'utf8'
  );

  /** Every `{ key: '...' }` the help overlay renders. */
  const advertised = [...HELP.matchAll(/\{\s*key:\s*'([^']+)'/g)].map(m => m[1]);

  it('advertises a non-trivial number of keys', () => {
    expect(advertised.length).toBeGreaterThan(20);
  });

  it('advertises no modifier combination the TUI does not bind', () => {
    // Only modifier-bearing entries are checked here. Plain letters in the help
    // text are display strings ('n / c / Space') and are covered by the keymap
    // consistency tests above.
    const bound = new Set(
      TUI_KEYMAP.concat(TUI_FUNCTION_KEYS).map(b => b.display.toLowerCase())
    );
    const modifiers = advertised.filter(k => /ctrl\+|alt\+|shift\+/i.test(k));
    expect(modifiers.length).toBeGreaterThan(0);

    const bogus = modifiers.filter(k => {
      // A help entry may list alternatives, e.g. ": / Ctrl+P".
      const parts = k.split('/').map(x => x.trim().toLowerCase());
      return !parts.some(part => bound.has(part));
    });
    expect(bogus).toEqual([]);
  });

  it('does not mention Ctrl+K, which the TUI never bound', () => {
    // The specific claim that was wrong. Named so a future edit that
    // reintroduces it fails loudly rather than subtly.
    expect(HELP).not.toContain('Ctrl+K');
  });
});
