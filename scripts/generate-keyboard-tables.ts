#!/usr/bin/env bun
/**
 * Generate docs/keyboard-shortcuts.md from the two key registries.
 *
 * ## Why
 *
 * That document described itself as "the single-source key map for the TUI and
 * the upcoming web UI" and matched neither. An audit found roughly twenty
 * documented keys that the web app does not bind, the web app's entire Alt and
 * Ctrl+Shift layer documented nowhere, five TUI bindings undocumented, and the
 * TUI's own help overlay advertising two shortcuts that were never bound.
 *
 * A key map maintained by hand alongside two implementations drifts. The only
 * thing that stops it is generation plus a check that fails.
 *
 * ## Sources
 *
 * - web: `packages/web/src/keyboard/actionRegistry.ts`, which the app already
 *   dispatches from, so it cannot be wrong about the web app.
 * - TUI: `packages/tui/src/keymap.ts`, which is data rather than the dispatcher.
 *   `packages/tui/src/keymap.test.ts` holds it to `App.tsx` in both directions,
 *   so an entry cannot exist without a handler and a handler cannot exist
 *   without an entry.
 * - divergences: `TUI_WEB_DIVERGENCES`, so a difference between the surfaces is
 *   recorded with a reason rather than left to be inferred.
 *
 * ## Usage
 *
 *   bun scripts/generate-keyboard-tables.ts            write the document
 *   bun scripts/generate-keyboard-tables.ts --check    exit 1 if it is stale
 *
 * The `--check` form runs in `bun run check`.
 */

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ActionRegistry,
  type ActionDefinition,
} from '../packages/web/src/keyboard/actionRegistry';
import { formatKeyCombo, type KeyCombo } from '../packages/web/src/keyboard/types';
import {
  TUI_KEYMAP,
  TUI_FUNCTION_KEYS,
  TUI_WEB_DIVERGENCES,
  type TuiBinding,
} from '../packages/tui/src/keymap';

const OUTPUT = resolve(import.meta.dir, '../docs/keyboard-shortcuts.md');

const CATEGORY_ORDER = [
  'Navigation',
  'View',
  'Search',
  'Comparison',
  'Analysis',
  'Simulation',
  'Overlays',
  'Education',
  'Export',
  'System',
  'Dev',
];

function sortCategories(categories: string[]): string[] {
  return categories.sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function formatShortcuts(shortcuts: KeyCombo | KeyCombo[] | undefined): string {
  if (!shortcuts) return '—';
  const combos = Array.isArray(shortcuts) ? shortcuts : [shortcuts];
  if (combos.length === 0) return '—';
  return combos.map(formatKeyCombo).join(' / ');
}

const escapePipes = (s: string): string => s.replace(/\|/g, '\\|');

// ---------------------------------------------------------------------------
// Web
// ---------------------------------------------------------------------------

function webSection(): string[] {
  const actions = Object.values(ActionRegistry).filter(
    (a): a is ActionDefinition => !a.surfaces || a.surfaces.includes('web')
  );

  const grouped = new Map<string, ActionDefinition[]>();
  for (const a of actions) {
    if (!grouped.has(a.category)) grouped.set(a.category, []);
    grouped.get(a.category)!.push(a);
  }

  const out: string[] = ['## Web app', ''];
  out.push(
    'Generated from `packages/web/src/keyboard/actionRegistry.ts`, which the app',
    'dispatches from directly. An action with no shortcut is reachable from the',
    'command palette or a menu.',
    ''
  );

  for (const category of sortCategories([...grouped.keys()])) {
    const rows = [...grouped.get(category)!].sort((a, b) =>
      a.title.localeCompare(b.title)
    );
    out.push(`### ${category}`, '');
    out.push('| Shortcut | Action | Provenance | Description |');
    out.push('|---|---|---|---|');
    for (const a of rows) {
      const shortcut = formatShortcuts(a.defaultShortcut);
      // Provenance is shown here for the same reason it is shown in the menu:
      // a heuristic or demo-driven overlay should be identifiable before it is
      // opened, not after.
      const prov = a.provenance && a.provenance !== 'measured' ? a.provenance : '';
      const fallback = a.provenanceFallback ? ` → ${a.provenanceFallback}` : '';
      out.push(
        `| \`${shortcut}\` | ${escapePipes(a.title)} | ${prov}${prov ? fallback : ''} | ${escapePipes(a.description ?? '')} |`
      );
    }
    out.push('');
  }
  return out;
}

// ---------------------------------------------------------------------------
// TUI
// ---------------------------------------------------------------------------

function tuiSection(): string[] {
  const grouped = new Map<string, TuiBinding[]>();
  for (const b of TUI_KEYMAP) {
    if (!grouped.has(b.category)) grouped.set(b.category, []);
    grouped.get(b.category)!.push(b);
  }

  const out: string[] = ['## Terminal UI', ''];
  out.push(
    'Generated from `packages/tui/src/keymap.ts`. That file is data, not the',
    'dispatcher, so `packages/tui/src/keymap.test.ts` holds it to the handler in',
    'both directions: an entry without a handler fails, and a handler without an',
    'entry fails.',
    '',
    'Bindings marked with a tier do nothing until the user reaches it. Tiers are',
    'reached by use over time or by manual promotion.',
    ''
  );

  for (const category of sortCategories([...grouped.keys()])) {
    const rows = [...grouped.get(category)!].sort((a, b) =>
      a.action.localeCompare(b.action)
    );
    out.push(`### ${category}`, '');
    out.push('| Key | Action | Tier |');
    out.push('|---|---|---|');
    for (const b of rows) {
      out.push(
        `| \`${escapePipes(b.display)}\` | ${escapePipes(b.action)} | ${b.tier ?? '—'} |`
      );
    }
    out.push('');
  }

  out.push('### Function keys', '');
  out.push('| Key | Action |');
  out.push('|---|---|');
  for (const b of TUI_FUNCTION_KEYS) {
    out.push(`| \`${b.display}\` | ${escapePipes(b.action)} |`);
  }
  out.push(
    '',
    'F11 is left to the terminal for fullscreen. F12 is bound in neither surface.',
    ''
  );
  return out;
}

// ---------------------------------------------------------------------------
// Divergences
// ---------------------------------------------------------------------------

function divergenceSection(): string[] {
  const out: string[] = ['## Where the two surfaces differ, and why', ''];
  out.push(
    'The surfaces are not required to agree. They are required to differ for a',
    'stated reason. A difference not listed here is drift.',
    ''
  );
  out.push('| Action | Terminal | Web | Why |');
  out.push('|---|---|---|---|');
  for (const d of TUI_WEB_DIVERGENCES) {
    out.push(
      `| ${escapePipes(d.action)} | \`${escapePipes(d.tui)}\` | \`${escapePipes(d.web)}\` | ${escapePipes(d.reason)} |`
    );
  }
  out.push('');
  return out;
}

// ---------------------------------------------------------------------------

function render(): string {
  const out: string[] = [];
  out.push('<!--');
  out.push('  GENERATED FILE. Do not edit by hand.');
  out.push('');
  out.push('  Regenerate:  bun scripts/generate-keyboard-tables.ts');
  out.push('  Check:       bun scripts/generate-keyboard-tables.ts --check');
  out.push('');
  out.push('  `bun run check` runs the check form, so an edit here fails the build.');
  out.push('  Change the registries instead:');
  out.push('    web  packages/web/src/keyboard/actionRegistry.ts');
  out.push('    tui  packages/tui/src/keymap.ts');
  out.push('-->');
  out.push('');
  out.push('# Keyboard shortcuts');
  out.push('');
  out.push(
    'This file is generated from the two key registries, so it cannot describe a',
    'binding that does not exist or omit one that does. It previously called',
    'itself a single source of truth while matching neither surface.',
    ''
  );
  out.push(...webSection());
  out.push(...tuiSection());
  out.push(...divergenceSection());
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

const content = render();
const check = process.argv.includes('--check');

if (check) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
  if (current !== content) {
    console.error('docs/keyboard-shortcuts.md is stale.');
    console.error('The key registries and the document disagree.');
    console.error('Run: bun scripts/generate-keyboard-tables.ts');
    process.exit(1);
  }
  console.log('docs/keyboard-shortcuts.md is up to date.');
} else {
  writeFileSync(OUTPUT, content);
  console.log(`Wrote ${OUTPUT}`);
}
