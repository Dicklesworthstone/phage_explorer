import { describe, expect, it } from 'bun:test';
import React from 'react';
import { render } from 'ink';
import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { importLocalGenomes } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import { createLocalGenomeRepository, type PhageRepository } from '@phage-explorer/db-runtime';
import { BiasDecompositionOverlay } from './BiasDecompositionOverlay';

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
    if (Date.now() >= deadline) throw new Error('Bias analysis did not reach the expected terminal state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function fixture(first = 'A'.repeat(18)) {
  const { genomes } = await importLocalGenomes({ name: 'bias.fa', text: '>FIRST\n' + first + '\n>SECOND\n' + 'C'.repeat(18) });
  genomes.forEach((genome, index) => { genome.phage.id = index + 1; });
  const repository = createLocalGenomeRepository<PhageRepository>(null, genomes);
  return { repository, genomes, phages: await repository.listPhages() };
}
function select(source: Awaited<ReturnType<typeof fixture>>) {
  usePhageStore.setState({ phages: source.phages, currentPhage: source.genomes[0].phage,
    overlays: ['biasDecomposition'], terminalCols: 110, terminalRows: 40 });
}
function terminal(repository: PhageRepository) {
  let output = '';
  const stdout = Object.assign(new Writable({ write(chunk, _encoding, callback) {
    output += stripVTControlCharacters(chunk.toString()); callback();
  } }), { columns: 110, rows: 40 });
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const ui = render(<BiasDecompositionOverlay repository={repository} />, {
    stdout: stdout as unknown as NodeJS.WriteStream, stdin: stdin as unknown as NodeJS.ReadStream,
    stderr: stdout as unknown as NodeJS.WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false,
  });
  return { ui, output: () => output, clear: () => { output = ''; },
    replace: (next: PhageRepository) => ui.rerender(<BiasDecompositionOverlay repository={next} />) };
}

describe('terminal bias source ownership', () => {
  it('recomputes same-ID, same-length replacement bases and hides old projections while loading', async () => {
    const previous = usePhageStore.getState();
    const first = await fixture(), second = await fixture('C'.repeat(18));
    const pending = deferred<string>();
    const replacement = { ...second.repository, getSequenceWindow: async (id: number, start: number, end: number) =>
      id === 1 ? pending.promise : second.repository.getSequenceWindow(id, start, end) } as PhageRepository;
    select(first);
    const test = terminal(first.repository);
    try {
      // A-only versus C-only has nonzero variance; C-only versus C-only has none.
      await waitFor(() => test.output().includes('PC1 100.0%'));
      test.clear();
      test.replace(replacement);
      await waitFor(() => test.output().includes('Loading dinucleotide vectors'));
      expect(test.output()).not.toContain('PC1 100.0%');
      expect(test.output()).not.toContain('Top loadings');
      pending.resolve('C'.repeat(18));
      await waitFor(() => test.output().includes('PC1 0.0%'));
      expect(test.output()).not.toContain('PC1 100.0%');
      expect(await second.repository.getBiasVector?.(1)).toEqual(Array.from({ length: 16 }, (_, i) => Number(i === 5)));
    } finally { test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });

  it('checks exact bases when a mounted repository receives a new catalog snapshot', async () => {
    const previous = usePhageStore.getState();
    const source = await fixture();
    select(source);
    const test = terminal(source.repository);
    try {
      await waitFor(() => test.output().includes('PC1 100.0%'));
      // The repository's optional ID cache still contains the original A vector.
      source.genomes[0].sequence = 'C'.repeat(18);
      test.clear();
      usePhageStore.setState({ phages: source.phages.map(phage => ({ ...phage })) });
      await waitFor(() => test.output().includes('PC1 0.0%'));
      expect(test.output()).not.toContain('PC1 100.0%');
      expect(await source.repository.getCodonVector?.(1)).toEqual(Array.from({ length: 64 }, (_, i) => Number(i === 21)));
    } finally { test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });

  it('does not let an abandoned read publish vectors or populate caches after replacement', async () => {
    const previous = usePhageStore.getState();
    const first = await fixture(), second = await fixture('C'.repeat(18));
    const pending = deferred<string>();
    let reads = 0, writes = 0;
    const old = { ...first.repository,
      getSequenceWindow: async () => { reads++; return pending.promise; },
      setBiasVector: async () => { writes++; }, setCodonVector: async () => { writes++; },
    } as PhageRepository;
    select(first);
    const test = terminal(old);
    try {
      await waitFor(() => reads === 1);
      test.replace(second.repository);
      await waitFor(() => test.output().includes('PC1 0.0%'));
      test.clear();
      pending.resolve('A'.repeat(18));
      await flush();
      expect(reads).toBe(1);
      expect(writes).toBe(0);
      expect(test.output()).not.toContain('PC1 100.0%');
      expect(test.output()).not.toContain('superseded');
    } finally { test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });

  it('recomputes malformed optional caches rather than passing nonfinite values to PCA', async () => {
    const previous = usePhageStore.getState();
    const source = await fixture();
    const repository = { ...source.repository,
      getBiasVector: async () => [NaN], getCodonVector: async () => Array(64).fill(1),
    } as PhageRepository;
    select(source);
    const test = terminal(repository);
    try {
      await waitFor(() => test.output().includes('PC1 100.0%'));
      expect(test.output()).not.toContain('NaN');
      expect(await source.repository.getBiasVector?.(1)).toEqual(Array.from({ length: 16 }, (_, i) => Number(i === 0)));
    } finally { test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });

  it('refuses partial genomes and clears an earlier result when replacement reads fail', async () => {
    const previous = usePhageStore.getState();
    const source = await fixture();
    select(source);
    const test = terminal(source.repository);
    try {
      await waitFor(() => test.output().includes('PC1 100.0%'));
      test.clear();
      test.replace({ ...source.repository, getSequenceWindow: async () => 'A' } as PhageRepository);
      await waitFor(() => test.output().includes('Incomplete genome sequence'));
      expect(test.output()).not.toContain('PC1 100.0%');
      expect(test.output()).not.toContain('Top loadings');
    } finally { test.ui.unmount(); await flush(); usePhageStore.setState(previous); }
  });
});
