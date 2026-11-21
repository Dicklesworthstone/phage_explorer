import { describe, expect, it } from 'bun:test';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { importLocalGenomes, type GeneInfo, type PhageFull } from '@phage-explorer/core';
import { createLocalGenomeRepository, type PhageRepository } from '@phage-explorer/db-runtime';
import { usePhageStore } from '@phage-explorer/state';
import { SyntenyOverlay } from './SyntenyOverlay';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Synteny did not reach the expected terminal state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const geneList = (names: string[]): GeneInfo[] => names.map((name, index) => ({
  id: index + 1, name, locusTag: null, product: null, startPos: index * 20,
  endPos: index * 20 + 10, strand: '+', type: 'CDS',
}));
async function fixture(referenceNames = ['alpha', 'beta', 'gamma']) {
  const imported = await importLocalGenomes({ name: 'synteny.fasta',
    text: '>Query\n' + 'ACGT'.repeat(20) + '\n>Reference\n' + 'ACGT'.repeat(20) + '\n>Third\n' + 'ACGT'.repeat(20) });
  const genomes = imported.genomes.map((genome, index) => ({ ...genome, phage: { ...genome.phage, id: -1 - index,
    genes: geneList(index === 1 ? referenceNames : index === 2 ? ['delta', 'epsilon', 'zeta'] : ['alpha', 'beta', 'gamma']) } }));
  const repository = createLocalGenomeRepository<PhageRepository>(null, genomes);
  return { repository, phages: genomes.map(genome => genome.phage) };
}
function select(phages: PhageFull[]) {
  usePhageStore.setState({ phages, currentPhageIndex: 0, comparisonPhageAIndex: 0, comparisonPhageBIndex: 1,
    overlays: ['synteny'], overlayData: {}, terminalCols: 110, terminalRows: 40 });
}
function terminal(repository: PhageRepository) {
  let output = '', latest = '', ready = false;
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) {
    const value = stripVTControlCharacters(chunk.toString()); output += value;
    if (value.trim()) latest = value;
    callback();
  } }), { columns: 110, rows: 40 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => { ready = true; }, ref() {}, unref() {} });
  const ui = render(<SyntenyOverlay repository={repository} />, { stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream, stderr: stdout as unknown as NodeJS.WriteStream,
    debug: true, patchConsole: false, exitOnCtrlC: false });
  return { ui, output: () => output, latest: () => latest, ready: () => ready,
    press: (value: string) => stdin.write(value),
    replace: (next: PhageRepository) => ui.rerender(<SyntenyOverlay repository={next} />) };
}

describe('terminal synteny source ownership', () => {
  it('recomputes reused IDs in a replacement repository and hides old results during its reads', async () => {
    const previous = usePhageStore.getState();
    const first = await fixture(), second = await fixture(['delta', 'epsilon', 'zeta']);
    select(first.phages);
    const test = terminal(first.repository);
    const gate = deferred<void>(); let reads = 0;
    const delayed = { ...second.repository, getPhageById: async (id: number) => {
      reads++; await gate.promise; return second.repository.getPhageById(id);
    } } as PhageRepository;
    try {
      await waitFor(() => test.latest().includes('Score: 100.0%'));
      test.replace(delayed);
      await waitFor(() => reads === 2 && test.latest().includes('Loading synteny'));
      expect(test.latest()).not.toContain('Score:');
      gate.resolve();
      await waitFor(() => test.latest().includes('Score: 0.0%'));
      expect(test.latest()).toContain('Blocks: 0');
      expect(test.latest()).not.toContain('alpha..gamma');
    } finally { gate.resolve(); test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });

  it('cannot let an abandoned reference read replace a newer selected pair', async () => {
    const previous = usePhageStore.getState(), data = await fixture(); select(data.phages);
    const gate = deferred<PhageFull | null>(); let held = false;
    const repository = { ...data.repository, getPhageById: (id: number) => {
      if (id === data.phages[1].id) { held = true; return gate.promise; }
      return data.repository.getPhageById(id);
    } } as PhageRepository;
    const test = terminal(repository);
    try {
      await waitFor(() => held && test.ready());
      test.press('\u001b[C');
      await waitFor(() => test.latest().includes('B: Third') && test.latest().includes('Score: 0.0%'));
      const accepted = test.latest();
      gate.resolve(data.phages[1]); await flush();
      expect(test.latest()).toBe(accepted);
      expect((usePhageStore.getState().overlayData as { synteny: { b: number } }).synteny.b).toBe(2);
    } finally { gate.resolve(data.phages[1]); test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });

  it('clears failed or unannotated sources and recovers only after an explicit retry or source change', async () => {
    const previous = usePhageStore.getState(), data = await fixture(), missing = await fixture([]); select(data.phages);
    let fail = true, reads = 0;
    const repository = { ...data.repository, getPhageById: async (id: number) => {
      reads++; if (fail) throw new Error('annotation read failed');
      return data.repository.getPhageById(id);
    } } as PhageRepository;
    const test = terminal(repository);
    try {
      await waitFor(() => test.latest().includes('annotation read failed'));
      expect(reads).toBe(2);
      await flush(); expect(reads).toBe(2);
      fail = false; await waitFor(test.ready); test.press('r');
      await waitFor(() => test.latest().includes('Score: 100.0%'));
      expect(reads).toBe(4);
      test.replace(missing.repository);
      await waitFor(() => test.latest().includes('Both genomes need gene annotations'));
      expect(test.latest()).not.toContain('Score:');
      test.replace(data.repository);
      await waitFor(() => test.latest().includes('Score: 100.0%'));
      expect(test.latest()).not.toContain('Error:');
    } finally { test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });

  it('drops pending reads when the panel closes without writing remembered selections', async () => {
    const previous = usePhageStore.getState(), data = await fixture(); select(data.phages);
    const gate = deferred<void>(); let reads = 0;
    const repository = { ...data.repository, getPhageById: async (id: number) => {
      reads++; await gate.promise; return data.repository.getPhageById(id);
    } } as PhageRepository;
    const test = terminal(repository);
    try {
      await waitFor(() => reads === 2 && test.ready());
      test.press('\u001b');
      await waitFor(() => !usePhageStore.getState().overlays.includes('synteny'));
      gate.resolve(); await flush();
      expect(usePhageStore.getState().overlayData).toEqual({});
      expect(test.latest()).not.toContain('Score:');
    } finally { gate.resolve(); test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });
});
