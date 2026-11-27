import { describe, expect, it } from 'bun:test';
import type { GeneInfo, PhageSummary } from '@phage-explorer/core';
import {
  buildShareUrl,
  ExplorerBrowserHistory,
  HistorySelectionAttempt,
  findGeneId,
  findPhageIndex,
  getGeneShareKey,
  getShareableTool,
  isShareableOverlayId,
  normalizeShareableOverlayId,
  parseShareState,
} from './share-state';

const phages: PhageSummary[] = [
  {
    id: 1,
    slug: 'lambda-phage',
    name: 'Enterobacteria phage lambda',
    accession: 'NC_001416',
    family: 'Siphoviridae',
    host: 'Escherichia coli',
    genomeLength: 48_502,
    gcContent: 49.86,
    morphology: 'Siphovirus',
    lifecycle: 'Temperate',
  },
  {
    id: 2,
    slug: 't4',
    name: 'Escherichia phage T4',
    accession: 'NC_000866',
    family: 'Straboviridae',
    host: 'Escherichia coli',
    genomeLength: 168_903,
    gcContent: 35.32,
    morphology: 'Myovirus',
    lifecycle: 'Lytic',
  },
];

const genes: GeneInfo[] = [
  {
    id: 101,
    name: 'major capsid protein',
    locusTag: 'T4_gp23',
    startPos: 1_000,
    endPos: 2_500,
    strand: '+',
    product: 'major capsid protein',
    type: 'CDS',
  },
  {
    id: 102,
    name: 'tail protein',
    locusTag: null,
    startPos: 3_000,
    endPos: 3_900,
    strand: '-',
    product: 'tail protein',
    type: 'CDS',
  },
];

describe('parseShareState', () => {
  it('parses a complete validated share state', () => {
    expect(
      parseShareState(
        'https://phage-explorer.org/?phage=t4&gene=T4_gp23&view=aa&pos=12345&frame=-2&model=0&tool=gcSkew'
      )
    ).toEqual({
      phageKey: 't4',
      geneKey: 'T4_gp23',
      viewMode: 'aa',
      position: 12_345,
      readingFrame: -2,
      show3DModel: false,
      tool: 'gcSkew',
    });
  });

  it('rejects malformed or unsupported values without throwing', () => {
    expect(
      parseShareState('/?phage=%20&gene=%20&view=protein&pos=-1&frame=7&model=maybe&tool=settings')
    ).toEqual({
      phageKey: null,
      geneKey: null,
      viewMode: null,
      position: null,
      readingFrame: null,
      show3DModel: null,
      tool: null,
    });
  });

  it('normalizes boolean and overlay spellings', () => {
    const parsed = parseShareState('/?model=TRUE&tool=GENOMICSIGNATUREPCA');
    expect(parsed.show3DModel).toBe(true);
    expect(parsed.tool).toBe('genomicSignaturePCA');
  });
});

describe('buildShareUrl', () => {
  it('builds a deterministic clean URL and removes tracking fragments', () => {
    const url = buildShareUrl('https://phage-explorer.org/?utm_source=test#old', {
      phageKey: 'lambda-phage',
      geneKey: 'LAMBDA_cI',
      viewMode: 'dual',
      position: 900.9,
      readingFrame: 1,
      show3DModel: true,
      tool: 'tropism',
    });

    expect(url).toBe(
      'https://phage-explorer.org/?phage=lambda-phage&gene=LAMBDA_cI&view=dual&pos=900&frame=1&model=1&tool=tropism'
    );
  });

  it('omits absent gene and analysis-tool state', () => {
    const url = new URL(
      buildShareUrl('https://preview.example/app?stale=1', {
        phageKey: 'NC_000866',
        viewMode: 'dna',
        position: 0,
        readingFrame: 0,
        show3DModel: false,
      })
    );

    expect(url.pathname).toBe('/app');
    expect(url.searchParams.get('phage')).toBe('NC_000866');
    expect(url.searchParams.get('gene')).toBeNull();
    expect(url.searchParams.get('tool')).toBeNull();
    expect(url.searchParams.get('stale')).toBeNull();
  });
});

describe('findPhageIndex', () => {
  it('matches stable slugs, accessions, IDs, and exact names case-insensitively', () => {
    expect(findPhageIndex(phages, 'T4')).toBe(1);
    expect(findPhageIndex(phages, 'nc_001416')).toBe(0);
    expect(findPhageIndex(phages, '2')).toBe(1);
    expect(findPhageIndex(phages, 'enterobacteria phage lambda')).toBe(0);
  });

  it('returns -1 for empty and unknown keys', () => {
    expect(findPhageIndex(phages, null)).toBe(-1);
    expect(findPhageIndex(phages, 'unknown-phage')).toBe(-1);
  });
});

describe('gene share identity', () => {
  it('prefers stable locus tags and falls back to the database gene ID', () => {
    expect(getGeneShareKey(genes[0])).toBe('T4_gp23');
    expect(getGeneShareKey(genes[1])).toBe('102');
    expect(getGeneShareKey(null)).toBeNull();
  });

  it('restores genes by locus tag, ID, or exact name case-insensitively', () => {
    expect(findGeneId(genes, 't4_GP23')).toBe(101);
    expect(findGeneId(genes, '102')).toBe(102);
    expect(findGeneId(genes, 'MAJOR CAPSID PROTEIN')).toBe(101);
  });

  it('returns null for missing and unknown genes', () => {
    expect(findGeneId(genes, null)).toBeNull();
    expect(findGeneId(genes, 'missing')).toBeNull();
  });
});

describe('shareable overlays', () => {
  it('keeps the top shareable tool from the actual overlay stack shape', () => {
    expect(getShareableTool([{ id: 'complexity' }, { id: 'gcSkew' }, { id: 'settings' }])).toBe('gcSkew');
    expect(getShareableTool([{ id: 'welcome' }])).toBeNull();
  });

  it('accepts analysis views and rejects transient application chrome', () => {
    expect(isShareableOverlayId('gcSkew')).toBe(true);
    expect(normalizeShareableOverlayId('RNASECONDARY')).toBeNull();
    expect(normalizeShareableOverlayId('RNASTRUCTURE')).toBe('rnaStructure');
    expect(isShareableOverlayId('settings')).toBe(false);
    expect(isShareableOverlayId('welcome')).toBe(false);
  });
});

describe('same-document explorer history', () => {
  it('keeps private views in memory, distinguishes private entries at the same URL, and preserves Forward after traversal', () => {
    const views = new ExplorerBrowserHistory();
    const location = new URL('https://example.org/explore') as unknown as Location;
    const entries: { state: Record<string, unknown>; url: string }[] = [{ state: { app: 1 }, url: location.href }];
    let index = 0;
    const history = {
      get state() { return entries[index].state; },
      replaceState(state: Record<string, unknown>, _title: string, url: string) {
        entries[index] = { state, url }; location.href = url;
      },
      pushState(state: Record<string, unknown>, _title: string, url: string) {
        entries.splice(++index, Infinity, { state, url }); location.href = url;
      },
    } as unknown as History;
    const view = { viewMode: 'dual', position: 20, readingFrame: 0, show3DModel: false } as const;
    const local = { ...phages[0], slug: 'local-secret', accession: 'private-accession',
      localGenome: { contentId: 'private-digest', sequenceSha256: 'digest', format: 'genbank', topology: 'linear' } } as const;
    views.write(location, history, phages[0], view);
    views.write(location, history, local, { ...view, geneKey: 'private-gene' });
    const plain = 'https://example.org/explore';
    expect(location.href).toBe(plain);
    expect(JSON.stringify(history.state)).not.toMatch(/private-accession|private-digest|private-gene|local-secret/);
    expect(history.state.app).toBe(1);
    const token = history.state.phageExplorerPrivateView;
    views.write(location, history, local, { ...view, geneKey: 'new-gene' });
    expect(history.state.phageExplorerPrivateView).toBe(token);
    views.write(location, history, { ...local, localGenome: { ...local.localGenome, contentId: 'second-input' } }, view);
    expect(entries).toHaveLength(3);
    expect(location.href).toBe(plain);
    expect(history.state.phageExplorerPrivateView).not.toBe(token);
    index--;
    location.href = entries[index].url;
    const back = views.read(location, history.state);
    expect(back?.source).toEqual({ kind: 'local', key: 'private-digest' });
    expect(back?.view.geneKey).toBe('new-gene');
    views.write(location, history, local, { ...view, geneKey: 'new-gene' });
    expect(entries).toHaveLength(3);
    expect(new ExplorerBrowserHistory().read(location, history.state)).toBeNull();
    index--;
    location.href = entries[index].url;
    expect(views.read(location, history.state)?.source).toEqual({ kind: 'catalog', key: 'lambda-phage' });
    views.write(location, history, phages[0], view);
    expect(entries).toHaveLength(3);
  });
});

describe('history selection ownership', () => {
  it('retires the history view when a new selection of the same index starts before paint', () => {
    const attempt = new HistorySelectionAttempt(2, true);
    expect(attempt.observe(2, 1, null)).toBe(true);
    expect(attempt.observe(null, 2, null)).toBe(true);
    expect(attempt.observe(2, 2, null)).toBe(false);
    expect(new HistorySelectionAttempt(2, false).observe(2, 2, null)).toBe(false);
  });

  it('preserves a failed destination through retries and stops when another selection supersedes it', () => {
    const attempt = new HistorySelectionAttempt(2, true);
    expect(attempt.observe(2, 1, null)).toBe(true);
    expect(attempt.observe(null, 1, 2)).toBe(true);
    expect(attempt.observe(2, 1, null)).toBe(true);
    expect(attempt.retrying).toBe(true);
    expect(attempt.observe(null, 1, 2)).toBe(true);
    expect(attempt.observe(2, 1, null)).toBe(true);
    expect(attempt.observe(null, 2, null)).toBe(true);
    expect(attempt.retrying).toBe(false);
    expect(attempt.observe(3, 2, null)).toBe(false);
  });

  it('retires a cancelled selection even if the destination never returned', () => {
    const attempt = new HistorySelectionAttempt(2, true);
    expect(attempt.observe(2, 1, null)).toBe(true);
    expect(attempt.observe(null, 1, null)).toBe(false);
  });
});
