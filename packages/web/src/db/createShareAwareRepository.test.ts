import { describe, expect, it } from 'bun:test';
import type { PhageFull, PhageSummary } from '@phage-explorer/core';
import type { PhageRepository } from './types';
import { createShareAwareRepository } from './createShareAwareRepository';

const summaries: PhageSummary[] = [
  {
    id: 1,
    slug: 'alpha',
    name: 'Alpha phage',
    accession: 'NC_ALPHA',
    family: null,
    host: null,
    genomeLength: 100,
    gcContent: 40,
    morphology: null,
    lifecycle: null,
  },
  {
    id: 2,
    slug: 'beta',
    name: 'Beta phage',
    accession: 'NC_BETA',
    family: null,
    host: null,
    genomeLength: 200,
    gcContent: 41,
    morphology: null,
    lifecycle: null,
  },
  {
    id: 3,
    slug: 'gamma',
    name: 'Gamma phage',
    accession: 'NC_GAMMA',
    family: null,
    host: null,
    genomeLength: 300,
    gcContent: 42,
    morphology: null,
    lifecycle: null,
  },
];

function full(summary: PhageSummary): PhageFull {
  return {
    ...summary,
    description: null,
    baltimoreGroup: null,
    genomeType: null,
    pdbIds: [],
    genes: [],
    codonUsage: null,
    hasModel: false,
  };
}

function createFakeRepository(): {
  repository: PhageRepository;
  indexCalls: number[];
  getListCalls: () => number;
} {
  const indexCalls: number[] = [];
  let listCalls = 0;

  const repository: PhageRepository = {
    listPhages: async () => {
      listCalls += 1;
      return summaries.slice();
    },
    getPhageByIndex: async (index) => {
      indexCalls.push(index);
      const summary = summaries[index];
      return summary ? full(summary) : null;
    },
    getPhageById: async (id) => {
      const summary = summaries.find((phage) => phage.id === id);
      return summary ? full(summary) : null;
    },
    getPhageBySlug: async (slug) => {
      const summary = summaries.find((phage) => phage.slug === slug);
      return summary ? full(summary) : null;
    },
    getSequenceWindow: async () => '',
    getFullGenomeLength: async () => 0,
    getGenes: async () => [],
    getCodonUsage: async () => null,
    hasModel: async () => false,
    getModelFrames: async () => null,
    prefetchAround: async () => undefined,
    searchPhages: async () => [],
    getPreference: async () => null,
    setPreference: async () => undefined,
    close: async () => undefined,
  };

  return { repository, indexCalls, getListCalls: () => listCalls };
}

describe('createShareAwareRepository', () => {
  it('rotates the visible list so the requested phage is first', async () => {
    const { repository } = createFakeRepository();
    const wrapped = createShareAwareRepository(repository, 'beta');

    expect((await wrapped.listPhages()).map((phage) => phage.slug)).toEqual([
      'beta',
      'gamma',
      'alpha',
    ]);
  });

  it('maps visible indexes back to the underlying repository', async () => {
    const { repository, indexCalls } = createFakeRepository();
    const wrapped = createShareAwareRepository(repository, 'beta');

    expect((await wrapped.getPhageByIndex(0))?.slug).toBe('beta');
    expect((await wrapped.getPhageByIndex(2))?.slug).toBe('alpha');
    expect(await wrapped.getPhageByIndex(99)).toBeNull();
    expect(indexCalls).toEqual([1, 0]);
  });

  it('shares one lazy list snapshot across concurrent calls', async () => {
    const { repository, getListCalls } = createFakeRepository();
    const wrapped = createShareAwareRepository(repository, 'gamma');

    await Promise.all([
      wrapped.listPhages(),
      wrapped.getPhageByIndex(0),
      wrapped.getPhageByIndex(1),
    ]);

    expect(getListCalls()).toBe(1);
  });

  it('prefetches neighbors in the rotated visible order', async () => {
    const { repository, indexCalls } = createFakeRepository();
    const wrapped = createShareAwareRepository(repository, 'beta');

    await wrapped.prefetchAround(0, 1);
    expect(new Set(indexCalls)).toEqual(new Set([0, 1, 2]));
  });

  it('returns the original repository when no phage key is requested', () => {
    const { repository } = createFakeRepository();
    expect(createShareAwareRepository(repository, null)).toBe(repository);
  });
});
