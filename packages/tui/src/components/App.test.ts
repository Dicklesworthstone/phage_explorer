import { describe, expect, it } from 'bun:test';
import type { GeneInfo } from '@phage-explorer/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  findNextGenePosition,
  findPreviousGenePosition,
  genePositionToScroll,
} from './gene-navigation';
import { matchModifierBinding, type ModifierBinding } from './App';
import React from 'react';
import { renderToString } from 'ink';
import { stripVTControlCharacters } from 'node:util';
import { importLocalGenomes } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import { GeneMap } from './GeneMap';
import { Model3DView } from './Model3DView';
import { FoldQuickview } from './FoldQuickview';
import { GelView } from './GelView';

describe('imported terminal genome views', () => {
  it('renders a circular origin cut, correct cut count and separated ladder bands', async () => {
    const { genomes } = await importLocalGenomes({ name: 'origin.fasta', text: '>Origin digest [topology=circular]\nAATTCAAAAG\n' });
    const saved = usePhageStore.getState();
    try {
      usePhageStore.setState({ currentPhage: genomes[0].phage });
      const circular = stripVTControlCharacters(renderToString(React.createElement(GelView, { sequence: genomes[0].sequence }), { columns: 100 }));
      expect(circular).toContain('Cuts: 1; fragments: 1');
      expect(circular).toContain('10 bp');
      expect(circular).toContain('Topology: circular');
      const rows = [20000, 10000, 5000, 2000, 1000, 500, 200].map(size => circular.split('\n').findIndex(line => line.includes(`—${size}—`)));
      expect(rows.every(row => row >= 0)).toBe(true);
      expect(rows.map(row => row - rows[0])).toEqual([0, 3, 5, 8, 10, 12, 15]);
      const phage = genomes[0].phage;
      usePhageStore.setState({ currentPhage: { ...phage, localGenome: { ...phage.localGenome!, topology: 'linear' } } });
      const linear = stripVTControlCharacters(renderToString(React.createElement(GelView, { sequence: genomes[0].sequence }), { columns: 100 }));
      expect(linear).toContain('Cuts: 0; fragments: 1');
      expect(linear).toContain('Topology: linear');
    } finally { usePhageStore.setState(saved); }
  });

  it('renders the hand-derived joined-CDS gaps and no invented private 3D model', async () => {
    const input = 'LOCUS       X 24 bp DNA circular\nFEATURES             Location/Qualifiers\n     CDS             complement(join(1..6,19..24))\nORIGIN\n        1 atgaaacccgggtttaaaccctag\n//\n';
    const { genomes } = await importLocalGenomes({ name: 'x.gb', text: input });
    const saved = usePhageStore.getState();
    try {
      usePhageStore.setState({ currentPhage: genomes[0].phage, scrollPosition: 0, viewMode: 'dna', overlayData: {}, show3DModel: true });
      const rendered = stripVTControlCharacters(renderToString(React.createElement(GeneMap, { width: 90, showDensityHistogram: false }), { columns: 100 }));
      const genesLine = rendered.split('\n').find(line => line.includes('Genes '));
      const bar = genesLine?.match(/[▼█▓◆·?]+/)?.[0];
      // 80 columns / 24 bases: 20 CDS, 40 gap, 20 CDS; column zero is the cursor.
      expect(bar).toBe(`▼${'█'.repeat(19)}${'·'.repeat(40)}${'█'.repeat(20)}`);
      const model = stripVTControlCharacters(renderToString(React.createElement(Model3DView, { width: 30, height: 16 }), { columns: 100 }));
      expect(model).toContain('No model');
      expect(model).not.toContain(genomes[0].phage.slug!);
      const fold = stripVTControlCharacters(renderToString(React.createElement(FoldQuickview, {
        embeddings: [{ geneId: genomes[0].phage.genes[0].id, vector: [1, 0], length: 4, name: 'Curated collision', product: null }],
        genomeSequence: genomes[0].sequence,
      }), { columns: 100 }));
      expect(fold).toContain('Fold reference data was not supplied');
      expect(fold).not.toContain('Novelty:');
      expect(fold).not.toContain('Nearest folds');
    } finally { usePhageStore.setState(saved); }
  });
});

// The App component is tightly coupled to Ink and the database, so we test
// the navigation helpers directly. These are the same functions used by the
// `[` / `]` key handlers.
describe('gene jump helpers', () => {
  const genes: GeneInfo[] = [
    { id: 1, name: 'A', startPos: 0, endPos: 100, strand: '+', type: 'CDS', product: null, locusTag: null },
    { id: 2, name: 'B', startPos: 250, endPos: 400, strand: '-', type: 'CDS', product: null, locusTag: null },
    { id: 3, name: 'C', startPos: 500, endPos: 700, strand: '+', type: 'CDS', product: null, locusTag: null },
  ];

  describe('findNextGenePosition', () => {
    it('jumps to the next gene start in DNA view', () => {
      expect(findNextGenePosition(genes, 0, 'dna')).toBe(250);
      expect(findNextGenePosition(genes, 250, 'dna')).toBe(500);
      expect(findNextGenePosition(genes, 500, 'dna')).toBeNull();
    });

    it('jumps to the next gene start in AA view (base-pair / 3)', () => {
      expect(findNextGenePosition(genes, 0, 'aa')).toBe(83); // floor(250 / 3)
      expect(findNextGenePosition(genes, 83, 'aa')).toBe(166); // floor(500 / 3)
    });

    it('returns null when there is no later gene', () => {
      expect(findNextGenePosition(genes, 600, 'dna')).toBeNull();
      expect(findNextGenePosition([], 0, 'dna')).toBeNull();
    });
  });

  describe('findPreviousGenePosition', () => {
    it('jumps to the previous gene start in DNA view', () => {
      expect(findPreviousGenePosition(genes, 600, 'dna')).toBe(500);
      expect(findPreviousGenePosition(genes, 500, 'dna')).toBe(250);
      expect(findPreviousGenePosition(genes, 0, 'dna')).toBeNull();
    });

    it('jumps to the previous gene start in AA view', () => {
      expect(findPreviousGenePosition(genes, 200, 'aa')).toBe(166); // floor(500 / 3)
      expect(findPreviousGenePosition(genes, 82, 'aa')).toBe(0);
    });

    it('returns null when there is no earlier gene', () => {
      expect(findPreviousGenePosition(genes, 0, 'dna')).toBeNull();
      expect(findPreviousGenePosition([], 0, 'dna')).toBeNull();
    });
  });

  describe('genePositionToScroll', () => {
    it('maps base-pair coordinates unchanged for DNA and dual views', () => {
      expect(genePositionToScroll(300, 'dna')).toBe(300);
      expect(genePositionToScroll(300, 'dual')).toBe(300);
    });

    it('maps base-pair coordinates to codon positions for AA view', () => {
      expect(genePositionToScroll(0, 'aa')).toBe(0);
      expect(genePositionToScroll(2, 'aa')).toBe(0);
      expect(genePositionToScroll(3, 'aa')).toBe(1);
      expect(genePositionToScroll(299, 'aa')).toBe(99);
    });
  });
});

/**
 * Modifier-bearing keys must not be shadowed by plain letters.
 *
 * Ink reports Ctrl+F as input 'f' with ctrl set, and Shift+Y as input 'Y' with
 * shift set. The input handler was one long if/else-if chain that tested
 * `input` without checking modifiers first, so whichever branch was written
 * earlier won:
 *
 *   Ctrl+F   documented as fold quickview   -> cycled the reading frame
 *   Ctrl+P   documented as command palette   -> opened the promoter overlay
 *   Shift+Y  documented as synteny           -> opened transcription flow
 *
 * Shift+A, Shift+G, Shift+P and Shift+S happened to sit before their
 * plain-letter branches and so worked. That is the tell that this was an
 * ordering accident rather than a design: the behaviour depended on the order
 * two unrelated branches were written in.
 */
describe('modifier key dispatch', () => {
  const fired: string[] = [];
  const bindings: ModifierBinding[] = [
    { ctrl: true, keys: ['f', 'F'], run: () => fired.push('ctrl+f') },
    { ctrl: true, keys: ['p', 'P'], run: () => fired.push('ctrl+p') },
    { shift: true, keys: ['y', 'Y'], run: () => fired.push('shift+y') },
    { shift: true, keys: ['a', 'A'], run: () => fired.push('shift+a') },
  ];

  const press = (input: string, key: { ctrl?: boolean; shift?: boolean }) =>
    matchModifierBinding(bindings, input, key)?.keys.join('');

  it('matches Ctrl+F, which Ink reports as lowercase f with ctrl', () => {
    expect(press('f', { ctrl: true })).toBe('fF');
  });

  it('matches Shift+Y, which Ink reports as uppercase Y with shift', () => {
    expect(press('Y', { shift: true })).toBe('yY');
  });

  it('does not match a plain letter against a ctrl binding', () => {
    // The half of the bug that mattered in the other direction: if matching
    // were loose, pressing 'f' would open the fold quickview instead of
    // cycling the reading frame.
    expect(press('f', {})).toBeUndefined();
    expect(press('p', {})).toBeUndefined();
  });

  it('does not match a shift binding when ctrl is also held', () => {
    // Exact matching on BOTH modifiers. Ctrl+Shift+Y is not Shift+Y.
    expect(press('Y', { shift: true, ctrl: true })).toBeUndefined();
  });

  it('does not match a ctrl binding when shift is also held', () => {
    expect(press('f', { ctrl: true, shift: true })).toBeUndefined();
  });

  it('distinguishes two bindings that share a letter', () => {
    // Ctrl+P is the command palette; Shift+P is phase portraits. A matcher that
    // ignored which modifier was held would fire the wrong one.
    expect(press('p', { ctrl: true })).toBe('pP');
    expect(press('P', { shift: true })).toBeUndefined(); // no shift+p in this fixture
  });

  it('runs the bound action', () => {
    fired.length = 0;
    matchModifierBinding(bindings, 'f', { ctrl: true })?.run();
    expect(fired).toEqual(['ctrl+f']);
  });
});

/**
 * The structural half. The matcher above can be correct while the handler still
 * consults it too late, which is precisely the bug that existed: the modifier
 * branches were present and unreachable.
 */
describe('the modifier table is consulted before the plain-letter chain', () => {
  const src = readFileSync(join(import.meta.dir, 'App.tsx'), 'utf8');

  it('dispatches modifiers before any plain-letter comparison in the handler', () => {
    const handlerStart = src.indexOf('useInput((input, key) => {');
    expect(handlerStart).toBeGreaterThan(0);
    const handler = src.slice(handlerStart);

    const dispatchAt = handler.indexOf('matchModifierBinding(modifierBindings');
    expect(dispatchAt).toBeGreaterThan(0);

    // The first plain-letter branch of the main chain. Anything matching
    // `input === '<single char>'` after the dispatch is fine; before it is the
    // bug. The fullscreen-3D block runs earlier and returns, so search from the
    // point where the shared handler proper begins.
    const chainStart = handler.indexOf("const promote = (level: ExperienceLevel)");
    expect(chainStart).toBeGreaterThan(0);
    expect(dispatchAt).toBeGreaterThan(chainStart);

    const between = handler.slice(chainStart, dispatchAt);
    expect(between).not.toMatch(/input === '[a-zA-Z]'/);
  });

  it('leaves no modifier test in the plain-letter chain', () => {
    // Every key.ctrl / key.shift test should now live in the table. A stray one
    // in the chain means a binding is back to depending on branch order.
    const handlerStart = src.indexOf('useInput((input, key) => {');
    const dispatchEnd =
      src.indexOf('matchModifierBinding(modifierBindings', handlerStart);
    const chain = src.slice(dispatchEnd);
    const code = chain
      .split('\n')
      .filter(l => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/key\.ctrl/);
    expect(code).not.toMatch(/key\.shift/);
  });

  it('has no F-key in the escape table without a handler', () => {
    // F12 sat in the table with no handler, so pressing it did nothing while
    // the table implied it was bound.
    const table = src.slice(src.indexOf('const F_KEYS'), src.indexOf('};', src.indexOf('const F_KEYS')));
    const declared = [...table.matchAll(/'(F\d+)'/g)].map(m => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    for (const f of new Set(declared)) {
      expect(src).toContain(`fKey === '${f}'`);
    }
  });
});

/**
 * The TUI must read the same database the web app does.
 *
 * `packages/tui/src/index.tsx` resolved `${cwd}/phage.db` BEFORE
 * `${cwd}/packages/web/public/phage.db`. Both exist in a working tree and they
 * are not the same file:
 *
 *   phage.db                      build intermediate, gitignored
 *   packages/web/public/phage.db  committed, shipped, read by the web app
 *
 * `bun run build:db` writes the first; `scripts/build-web-db.ts` then VACUUMs it
 * into the second. Critically, the plain `build:db` produces NO Pfam domains and
 * NO ESM2 embeddings -- those come from `build:db:annotated`. So a developer who
 * ran the plain build got a TUI missing those annotations while the web app
 * showed them, with nothing to indicate the two were reading different files.
 *
 * These are source-level assertions because the resolver reads the filesystem
 * and process.cwd(); asserting on the ORDER of the candidate list is what
 * actually pins the behaviour.
 */
describe('database resolution prefers the committed database', () => {
  const src = readFileSync(join(import.meta.dir, '../index.tsx'), 'utf8');

  const indexOfCandidate = (needle: string): number => src.indexOf(needle);

  it('reads the resolver source', () => {
    expect(src).toContain('getCandidateDbPaths');
  });

  it('puts the committed database ahead of the build intermediate', () => {
    const committed = indexOfCandidate("'packages', 'web', 'public', 'phage.db'");
    const intermediate = indexOfCandidate("add(path.join(process.cwd(), 'phage.db'))");
    expect(committed).toBeGreaterThan(0);
    expect(intermediate).toBeGreaterThan(0);
    expect(committed).toBeLessThan(intermediate);
  });

  it('still honours the explicit override ahead of both', () => {
    // Someone iterating on the pipeline needs a way to point at their own file.
    const override = indexOfCandidate('PHAGE_EXPLORER_DB_PATH');
    const committed = indexOfCandidate("'packages', 'web', 'public', 'phage.db'");
    expect(override).toBeGreaterThan(0);
    expect(override).toBeLessThan(committed);
  });

  it('keeps the intermediate as a fallback rather than dropping it', () => {
    // A fresh clone that has run build:db but has no committed database must
    // still work, so the intermediate stays in the list.
    expect(indexOfCandidate("add(path.join(process.cwd(), 'phage.db'))")).toBeGreaterThan(0);
  });

  it('says which database it chose when a different one is being shadowed', () => {
    // Silently preferring one of two databases is how the original confusion
    // arose. The warning names both and how to override.
    expect(src).toContain('warnIfShadowedDatabase');
    expect(src).toContain('being ignored');
    expect(src).toContain('PHAGE_EXPLORER_DB_PATH to');
  });
});
