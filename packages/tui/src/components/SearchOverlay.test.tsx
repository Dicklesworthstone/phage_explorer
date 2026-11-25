import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render, Text } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { usePhageStore } from '@phage-explorer/state';
import { importLocalGenomes } from '../../../core/src/genome-import';
import { createLocalGenomeRepository } from '../../../db-runtime/src/local-genomes';
import type { PhageRepository } from '../../../db-runtime/src/types';
import type { SearchRequest, SearchResponse } from '../../../web/src/workers/types';
import { SearchOverlay } from './SearchOverlay';

const waitFor = async (condition: () => boolean, description = 'search state') => {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};
type Execute = (request: SearchRequest, signal: AbortSignal) => Promise<SearchResponse>;
function SearchHost(props: { repository: PhageRepository; runSearch?: Execute; width?: number }) {
  const open = usePhageStore(s => s.overlays.includes('search'));
  return open ? <SearchOverlay {...props} /> : <Text>Search closed</Text>;
}
function terminal(repository: PhageRepository, runSearch?: Execute, width = 84) {
  let frame = '', ready = false;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) { frame = stripVTControlCharacters(chunk.toString()); callback(); } }), { columns: width, rows: 24 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() { ready = true; }, ref() {}, unref() {} });
  const ui = render(<SearchHost repository={repository} runSearch={runSearch} width={width} />, {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  return { ui, frame: () => frame, ready: () => ready, input: (value: string) => stdin.write(value),
    repository: (value: PhageRepository) => ui.rerender(<SearchHost repository={value} runSearch={runSearch} width={width} />) };
}
async function fixture(topology?: 'linear' | 'circular') {
  const imported = await importLocalGenomes({ name: 'search.fa', text: `>alpha${topology ? ` [topology=${topology}]` : ''}\nAAAACCCCGGGGTTTT\n>beta\nATGATGATG` });
  imported.genomes[0].phage.genes = [
    { id: 101, startPos: 0, endPos: 4, strand: '+', name: 'AlphaBridgeCore', locusTag: 'ABC_1', product: 'small capsid', type: 'CDS' },
    { id: 102, startPos: 4, endPos: 12, strand: '-', name: 'tail_fiber', locusTag: 'TF_1', product: 'receptor binding protein', type: 'misc_feature' },
  ];
  const repository = createLocalGenomeRepository(null, imported.genomes), phages = await repository.listPhages();
  const phage = imported.genomes[0].phage;
  usePhageStore.setState({ phages, currentPhage: phage, currentPhageIndex: phages.findIndex(item => item.id === phage.id),
    isLoadingPhage: false, viewMode: 'dna', scrollPosition: 0, selectedGeneId: null,
    searchQuery: '', searchResults: [], overlays: ['search'] });
  return { repository, phages, phage };
}
async function mode(test: ReturnType<typeof terminal>, tabs: number, name: string) {
  const names = ['Sequence', 'Motif', 'Gene', 'Feature', 'Position'];
  for (let i = 0; i < tabs; i++) {
    test.input('\t');
    await waitFor(() => test.frame().includes(`SEARCH · ${names[i]}`), 'mode change');
  }
  await waitFor(() => test.frame().includes(`SEARCH · ${name}`), name);
}

describe('native genomic search keyboard workflow', () => {
  it('uses annotated circular topology, displays split intervals and navigates to their forward start', async () => {
    const previous = usePhageStore.getState(), data = await fixture('circular');
    const test = terminal(data.repository);
    try {
      await waitFor(test.ready); await mode(test, 1, 'Sequence');
      await waitFor(() => test.frame().includes('circular (annotation)'));
      test.input('\u0013'); await waitFor(() => test.frame().includes('Strand +'));
      test.input('TTA'); await waitFor(() => test.frame().includes('1 match'));
      assert(test.frame().includes('[14,16) + [0,1) wraps origin'));
      test.input('\r'); await waitFor(() => !usePhageStore.getState().overlays.includes('search'));
      assert.equal(usePhageStore.getState().scrollPosition, 14);
    } finally { test.ui.unmount(); await data.repository.close(); usePhageStore.setState(previous); }
  });

  it('requires an explicit circular assumption for unknown inputs and discards it when the source changes', async () => {
    const previous = usePhageStore.getState(), data = await fixture();
    const test = terminal(data.repository);
    try {
      await waitFor(test.ready); await mode(test, 1, 'Sequence');
      await waitFor(() => test.frame().includes('unknown (linear interval)'));
      test.input('\u0013'); await waitFor(() => test.frame().includes('Strand +'));
      test.input('TTA'); await waitFor(() => test.frame().includes('0 matches'));
      test.input('\u000f'); await waitFor(() => test.frame().includes('1 match'));
      assert(test.frame().includes('circular (user)'));
      test.input('\u000f'); await waitFor(() => test.frame().includes('linear (user)'));
      await waitFor(() => test.frame().includes('0 matches'));
      test.input('\u000f'); await waitFor(() => test.frame().includes('unknown (linear interval)'));
      test.input('\u000f'); await waitFor(() => test.frame().includes('1 match'));
      // The same numeric ID and bases in a replacement repository still form a
      // new source. An explicit assumption from the previous source cannot leak.
      test.repository(new Proxy(data.repository, {}));
      await waitFor(() => test.frame().includes('unknown (linear interval)'));
      await waitFor(() => test.frame().includes('0 matches'));
    } finally { test.ui.unmount(); await data.repository.close(); usePhageStore.setState(previous); }
  });

  for (const example of [
    { name: 'Sequence', tabs: 1, query: 'CCC', count: 4, down: 2, position: 9, gene: null, aa: true },
    { name: 'Motif', tabs: 2, query: 'AR', count: 6, down: 0, position: 0, gene: null },
    { name: 'Gene', tabs: 3, query: 'tlbr', count: 1, down: 0, position: 4, gene: 102 },
    { name: 'Gene', tabs: 3, query: 'TF_1', count: 1, down: 0, position: 4, gene: 102 },
    { name: 'Feature', tabs: 4, query: 'CDS', count: 1, down: 0, position: 0, gene: 101 },
    { name: 'Position', tabs: 5, query: '12', count: 1, down: 0, position: 12, gene: null },
  ]) it(`searches ${example.name.toLowerCase()} for ${example.query} with the real worker and navigates the selected result`, async () => {
    const previous = usePhageStore.getState(), data = await fixture();
    if (example.aa) usePhageStore.setState({ viewMode: 'aa', readingFrame: -2 });
    const test = terminal(data.repository);
    try {
      await waitFor(test.ready); await mode(test, example.tabs, example.name);
      test.input(example.query);
      await waitFor(() => test.frame().includes(`${example.count} match`), `${example.name} matches: ${example.query}`);
      for (let i = 0; i < example.down; i++) {
        test.input('\u001b[B'); await waitFor(() => test.frame().includes(`${i + 2}/${example.count}`));
      }
      test.input('\r'); await waitFor(() => !usePhageStore.getState().overlays.includes('search'));
      const state = usePhageStore.getState();
      assert.equal(state.scrollPosition, example.aa ? Math.floor(example.position / 3) : example.position);
      assert.equal(state.selectedGeneId, example.gene);
      assert.strictEqual(state.currentPhage, data.phage);
      if (example.aa) { assert.equal(state.viewMode, 'aa'); assert.equal(state.readingFrame, -2); }
    } finally { test.ui.unmount(); await data.repository.close(); usePhageStore.setState(previous); }
  });

  for (const example of [
    { frame: 1, query: '15', view: 'aa', position: 4 },
    { frame: -1, query: '12', view: 'aa', position: 3 },
    { frame: -3, query: '15', view: 'dna', position: 15 },
  ] as const) it(`opens position ${example.query} in frame ${example.frame} at its displayed cell`, async () => {
    const previous = usePhageStore.getState(), data = await fixture();
    usePhageStore.setState({ viewMode: 'aa', readingFrame: example.frame });
    const test = terminal(data.repository);
    try {
      await waitFor(test.ready);
      await mode(test, 5, 'Position');
      test.input(example.query);
      await waitFor(() => test.frame().includes('1 match'));
      test.input('\r');
      await waitFor(() => !usePhageStore.getState().overlays.includes('search'));
      const state = usePhageStore.getState();
      assert.equal(state.viewMode, example.view);
      assert.equal(state.scrollPosition, example.position);
      assert.equal(state.readingFrame, example.frame);
    } finally { test.ui.unmount(); await data.repository.close(); usePhageStore.setState(previous); }
  });

  it('preserves catalog lookup and ignores an older catalog reply after the query changes', async () => {
    const previous = usePhageStore.getState(), data = await fixture();
    let first!: (value: typeof data.phages) => void;
    const started: string[] = [];
    data.repository.searchPhages = query => {
      started.push(query);
      return query === 'alpha' ? new Promise(resolve => { first = resolve; })
        : Promise.resolve(data.phages.filter(phage => phage.name === query));
    };
    const test = terminal(data.repository);
    try {
      await waitFor(test.ready);
      test.input('\u001b[B'); test.input('\r');
      assert(usePhageStore.getState().overlays.includes('search'), 'empty Down/Enter cannot select a negative index');
      test.input('alpha'); await waitFor(() => started.includes('alpha'));
      test.input('\u0015'); await waitFor(() => usePhageStore.getState().searchQuery === '');
      test.input('beta'); await waitFor(() => test.frame().includes('1 match'));
      first(data.phages.filter(phage => phage.name === 'alpha'));
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.deepEqual(usePhageStore.getState().searchResults.map(phage => phage.name), ['beta']);
      test.input('\r'); await waitFor(() => !usePhageStore.getState().overlays.includes('search'));
      assert.equal(usePhageStore.getState().phages[usePhageStore.getState().currentPhageIndex].name, 'beta');
      assert.equal(usePhageStore.getState().searchQuery, 'beta');
    } finally { test.ui.unmount(); await data.repository.close(); usePhageStore.setState(previous); }
  });

  it('cancels superseded scans, rejects old query results, and blocks same-ID catalog replacement navigation', async () => {
    const previous = usePhageStore.getState(), data = await fixture();
    const pending: Array<{ request: SearchRequest; signal: AbortSignal; resolve: (response: SearchResponse) => void }> = [];
    const test = terminal(data.repository, (request, signal) => new Promise(resolve => { pending.push({ request, signal, resolve }); }));
    try {
      await waitFor(test.ready); await mode(test, 1, 'Sequence');
      test.input('AAA'); await waitFor(() => pending.length === 1);
      test.input('C'); await waitFor(() => pending.length === 2);
      assert.equal(pending[0].signal.aborted, true);
      pending[0].resolve({ mode: 'sequence', query: 'AAA', hits: [{ position: 0, end: 3, strand: '+', label: 'obsolete query' }] });
      await new Promise(resolve => setTimeout(resolve, 30));
      assert(!test.frame().includes('obsolete query')); test.input('\r');
      assert(usePhageStore.getState().overlays.includes('search'));
      pending[1].resolve({ mode: 'sequence', query: 'AAAC', hits: [{ position: 1, end: 5, strand: '+', label: 'current query' }] });
      await waitFor(() => test.frame().includes('current query'));
      usePhageStore.setState({ phages: data.phages.map(phage => ({ ...phage })) });
      test.input('\r'); await new Promise(resolve => setTimeout(resolve, 30));
      assert(usePhageStore.getState().overlays.includes('search'));
      assert.equal(usePhageStore.getState().scrollPosition, 0);
      await waitFor(() => pending.length === 3);
      test.input('\u001b'); await waitFor(() => !usePhageStore.getState().overlays.includes('search'));
      assert.equal(pending[2].signal.aborted, true);
    } finally { test.ui.unmount(); await data.repository.close(); usePhageStore.setState(previous); }
  });

  it('keeps unavailable inputs distinct from no matches and retries a failed complete-sequence read', async () => {
    const previous = usePhageStore.getState(), data = await fixture(), read = data.repository.getSequenceWindow;
    data.repository.getSequenceWindow = async () => 'AAA';
    const test = terminal(data.repository);
    try {
      await waitFor(test.ready); await mode(test, 1, 'Sequence'); test.input('CCC');
      await waitFor(() => test.frame().includes('complete genome could not be read'));
      assert(!test.frame().includes('0 matches'));
      test.input('\r'); assert(usePhageStore.getState().overlays.includes('search'));
      await new Promise(resolve => setTimeout(resolve, 20));
      data.repository.getSequenceWindow = read; test.input('\u0012');
      await waitFor(() => test.frame().includes('4 matches'));
      usePhageStore.setState({ isLoadingPhage: true });
      await waitFor(() => test.frame().includes('Selected genome is loading'));
      test.input('\r'); assert(usePhageStore.getState().overlays.includes('search'));
      assert.equal(usePhageStore.getState().scrollPosition, 0);
    } finally { test.ui.unmount(); await data.repository.close(); usePhageStore.setState(previous); }
  });

  it('owns option shortcuts and bounded horizontal query editing without inserting shortcut letters', async () => {
    const previous = usePhageStore.getState(), data = await fixture();
    const requests: SearchRequest[] = [];
    const test = terminal(data.repository, async request => { requests.push(request); return { mode: request.mode, query: request.query, hits: [] }; }, 64);
    try {
      await waitFor(test.ready); await mode(test, 1, 'Sequence'); test.input('ACG');
      await waitFor(() => test.frame().includes('Query: ACG'));
      test.input('\u0013'); await waitFor(() => test.frame().includes('Strand +'));
      test.input('\u000e'); await waitFor(() => test.frame().includes('mismatches 1'));
      test.input('\u0014'); await waitFor(() => test.frame().includes('case on'));
      await waitFor(() => requests.length > 0 && requests.at(-1)?.options?.caseSensitive === true);
      assert.equal(requests.at(-1)?.query, 'ACG');
      assert.deepEqual(requests.at(-1)?.options, { strand: '+', topology: 'linear', mismatches: 1, caseSensitive: true, fuzzy: false, maxResults: 500 });
      await waitFor(() => test.frame().includes('0 matches'));
      const beforeDelete = requests.length;
      test.input('\u001b[3~'); await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(requests.length, beforeDelete, 'Delete at end does not discard completed results');
      assert(test.frame().includes('0 matches'), 'a no-op edit must not leave search pending');
      test.input('\u0015'); await waitFor(() => test.frame().includes('Type a query'));
      test.input('\u001b[200~' + 'A'.repeat(10000) + '\u001b[201~'); await waitFor(() => requests.at(-1)?.query.length === 10000);
      assert(test.frame().split('\n').every(line => Array.from(line).length <= 64), 'long query stays inside the terminal width');
      const count = requests.length; test.input('C'); await new Promise(resolve => setTimeout(resolve, 200));
      assert.equal(requests.length, count, 'query beyond 10,000 characters is not accepted');
      test.input('\u0015'); await waitFor(() => test.frame().includes('Type a query'));
      test.input('\u001b[200~G\r\u0013\t\u001b[201~'); await waitFor(() => requests.at(-1)?.query === 'G');
      assert(usePhageStore.getState().overlays.includes('search'), 'pasted Return is not a submit action');
      assert(test.frame().includes('Strand +'), 'pasted Ctrl+S is not an option command');
      assert(test.frame().includes('SEARCH · Sequence'), 'pasted Tab is not a mode command');
      test.input('\u001b[Z'); await waitFor(() => test.frame().includes('SEARCH · Catalog'));
    } finally { test.ui.unmount(); await data.repository.close(); usePhageStore.setState(previous); }
  });
});
