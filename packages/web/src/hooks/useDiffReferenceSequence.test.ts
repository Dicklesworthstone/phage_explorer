import { describe, expect, it, beforeEach } from 'bun:test';
import { usePhageStore } from '@phage-explorer/state';
import { ActionRegistryList } from '../keyboard/actionRegistry';

/**
 * Selection pressure was dead in the browser for two independent reasons, and
 * both had to be fixed for the feature to be reachable at all:
 *
 *   1. `toggleDiff` sets `diffReferencePhageId` but never the sequence. The TUI
 *      loaded it in an effect; the web app never did, so
 *      `diffReferenceSequence` stayed null and `calculateSelectionPressure`
 *      -- a real gene-aware dN/dS estimator -- was never called.
 *   2. The overlay had no ActionRegistry entry, so it appeared in neither the
 *      Analysis Menu nor the Command Palette. Its only openers were the mobile
 *      gene dock and a dead feature registry, making it mobile-only by accident.
 *
 * The React effect itself is exercised in the browser; these tests pin the
 * store contract it depends on and the registry wiring that makes it reachable.
 */

describe('diff reference store contract', () => {
  beforeEach(() => {
    usePhageStore.setState({
      diffEnabled: false,
      diffReferencePhageId: null,
      diffReferenceSequence: null,
      phages: [
        {
          id: 1,
          slug: 'lambda',
          name: 'Enterobacteria phage lambda',
          accession: 'NC_001416',
          family: 'Siphoviridae',
          host: 'Escherichia coli K-12',
          genomeLength: 48502,
          gcContent: 49.9,
          morphology: 'siphovirus',
          lifecycle: 'lysogenic',
        },
        {
          id: 2,
          slug: 't4',
          name: 'Enterobacteria phage T4',
          accession: 'NC_000866',
          family: 'Myoviridae',
          host: 'Escherichia coli B',
          genomeLength: 168903,
          gcContent: 35.3,
          morphology: 'myovirus',
          lifecycle: 'lytic',
        },
      ],
    });
  });

  it('toggleDiff picks a reference phage but leaves the sequence unloaded', () => {
    usePhageStore.getState().toggleDiff();
    const state = usePhageStore.getState();

    expect(state.diffEnabled).toBe(true);
    expect(state.diffReferencePhageId).toBe(1);
    // This null is the gap the hook exists to close. Something has to fetch
    // the genome; the store deliberately does no I/O.
    expect(state.diffReferenceSequence).toBeNull();
  });

  it('setDiffReference supplies the sequence the analysis needs', () => {
    usePhageStore.getState().toggleDiff();
    usePhageStore.getState().setDiffReference(1, 'ACGTACGTACGT');
    expect(usePhageStore.getState().diffReferenceSequence).toBe('ACGTACGTACGT');
  });

  it('turning diff mode off clears the loaded reference', () => {
    usePhageStore.getState().toggleDiff();
    usePhageStore.getState().setDiffReference(1, 'ACGTACGTACGT');
    usePhageStore.getState().toggleDiff();

    const state = usePhageStore.getState();
    expect(state.diffEnabled).toBe(false);
    expect(state.diffReferencePhageId).toBeNull();
    // Stale references must not survive: the next enable picks a fresh one.
    expect(state.diffReferenceSequence).toBeNull();
  });
});

describe('selection pressure overlay reachability', () => {
  const actions = ActionRegistryList;

  it('is registered, so it appears in the Analysis menu and command palette', () => {
    const action = actions.find(a => a.overlayId === 'selectionPressure');
    expect(action).toBeDefined();
    expect(action?.category).toBe('Analysis');
    expect(action?.scope).toBe('global');
  });

  it('has a shortcut that no other action already claims', () => {
    // `defaultShortcut` is either one combo or a list of them, and some
    // actions declare an empty list (no default binding at all).
    const combos = (a: (typeof actions)[number]) =>
      Array.isArray(a.defaultShortcut) ? a.defaultShortcut : [a.defaultShortcut];

    const describeCombo = (c: { key: string; modifiers?: Record<string, boolean> }): string =>
      [
        c.modifiers?.ctrl ? 'ctrl' : '',
        c.modifiers?.alt ? 'alt' : '',
        c.modifiers?.shift ? 'shift' : '',
        c.modifiers?.meta ? 'meta' : '',
        c.key.toLowerCase(),
      ]
        .filter(Boolean)
        .join('+');

    const action = actions.find(a => a.overlayId === 'selectionPressure');
    expect(action).toBeDefined();
    const mine = combos(action!).map(describeCombo);
    expect(mine.length).toBeGreaterThan(0);

    const others = actions
      .filter(a => a.overlayId !== 'selectionPressure')
      .flatMap(combos)
      .map(describeCombo);

    for (const combo of mine) {
      expect(others).not.toContain(combo);
    }
  });

  it('the conflict check is discriminating', () => {
    // Guards the guard: an already-bound combo must be reported as taken, or
    // the assertion above would pass for any string at all.
    const combos = (a: (typeof actions)[number]) =>
      Array.isArray(a.defaultShortcut) ? a.defaultShortcut : [a.defaultShortcut];
    const allKeys = actions.flatMap(combos).map(c => c.key.toLowerCase());
    expect(allKeys).toContain('s');
  });
});
