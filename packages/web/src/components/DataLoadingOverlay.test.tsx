import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataLoadingOverlay } from './DataLoadingOverlay';
import type { DatabaseLoadProgress } from '../db';

describe('catalog startup can open private research', () => {
  test('offers a named local-workspace action during loading, offline failure and unavailable SQLite', () => {
    const states: Array<{ progress: DatabaseLoadProgress; error: string | null }> = [
      { progress: { stage: 'checking', percent: 0, message: 'Checking the catalog' }, error: null },
      { progress: { stage: 'downloading', percent: 30, message: 'Downloading the catalog' }, error: null },
      { progress: { stage: 'error', percent: 0, message: 'Catalog unavailable' }, error: 'Database manifest unavailable' },
      { progress: { stage: 'error', percent: 0, message: 'SQLite unavailable' }, error: 'WebAssembly not supported' },
    ];
    for (const state of states) {
      const html = renderToStaticMarkup(<DataLoadingOverlay {...state} onRetry={() => {}}
        onOpenLocalGenomes={() => { throw new Error('Rendering must not open a workspace or change private inputs.'); }} />);
      expect(html).toContain('>Open local genomes</button>');
      expect(html).toContain('reopen saved genomes and workflows');
      expect(html).toContain('Analyses that need external reference data still require those inputs.');
    }
  });
});
