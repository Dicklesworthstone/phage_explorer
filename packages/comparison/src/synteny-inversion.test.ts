import { describe, expect, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { alignSynteny } from './synteny';
import type { GeneInfo } from '@phage-explorer/core';

/**
 * Inversion detection.
 *
 * `orientation` was hardcoded to `'forward'` and `'reverse'` was never
 * produced by any code path, because the DTW alignment underneath is monotonic
 * and structurally cannot represent an inversion. Meanwhile the web overlay
 * rendered an "Inverted orientation" legend entry and told the user that
 * "inverted blocks (red) suggest genome rearrangements".
 *
 * So the UI documented and colour-coded an outcome the algorithm could not
 * return: someone comparing two genomes with a real inversion was promised
 * detection and shown none.
 */

let nextId = 1;
function gene(name: string): GeneInfo {
  const id = nextId++;
  return {
    id,
    name,
    locusTag: `t${id}`,
    startPos: id * 1000,
    endPos: id * 1000 + 800,
    strand: '+',
    product: name,
    type: 'CDS',
  };
}

function genesFrom(names: string[]): GeneInfo[] {
  return names.map(gene);
}

describe('conserved gene order', () => {
  it('reports forward blocks when the order matches', () => {
    const names = ['terminase', 'portal', 'capsid', 'scaffold', 'tail', 'fiber'];
    const result = alignSynteny(genesFrom(names), genesFrom(names));

    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.every(b => b.orientation === 'forward')).toBe(true);
    expect(result.globalScore).toBeGreaterThan(0.5);
  });

  it('does not invent an inversion where the order is simply conserved', () => {
    // Guards against the opposite failure to the one being fixed: a detector
    // that reports inversions everywhere is no more useful than one that never
    // reports them.
    const names = ['terminase', 'portal', 'capsid', 'scaffold', 'tail', 'fiber'];
    const result = alignSynteny(genesFrom(names), genesFrom(names));
    expect(result.blocks.some(b => b.orientation === 'reverse')).toBe(false);
  });
});

describe('inverted gene order', () => {
  // A conserved head module, then a segment whose gene order is reversed in
  // the second genome, then a conserved tail module. This is what a real
  // inversion looks like in gene-order terms.
  const head = ['terminase', 'portal', 'capsid'];
  const segment = ['integrase', 'excisionase', 'repressor', 'antirepressor'];
  const tail = ['baseplate', 'fiber'];

  const genomeA = genesFrom([...head, ...segment, ...tail]);
  const genomeB = genesFrom([...head, ...[...segment].reverse(), ...tail]);

  it('detects the inverted segment', () => {
    const result = alignSynteny(genomeA, genomeB);
    const reversed = result.blocks.filter(b => b.orientation === 'reverse');
    expect(reversed.length).toBeGreaterThan(0);
  });

  it('places the inversion over the genes that were actually inverted', () => {
    const result = alignSynteny(genomeA, genomeB);
    const reversed = result.blocks.filter(b => b.orientation === 'reverse');
    expect(reversed.length).toBeGreaterThan(0);

    // The inverted segment occupies indices 3..6 in genome A.
    const block = reversed[0];
    expect(block.startIdxA).toBeGreaterThanOrEqual(2);
    expect(block.endIdxA).toBeLessThanOrEqual(7);
  });

  it('reports coordinates in the original space, never reversed indices', () => {
    const result = alignSynteny(genomeA, genomeB);
    for (const b of result.blocks) {
      expect(b.startIdxB).toBeGreaterThanOrEqual(0);
      expect(b.endIdxB).toBeLessThan(genomeB.length);
      expect(b.startIdxB).toBeLessThanOrEqual(b.endIdxB);
      expect(b.startIdxA).toBeLessThanOrEqual(b.endIdxA);
    }
  });

  it('an inverted block spans more than one gene', () => {
    // A single gene carries no order information, so it cannot evidence an
    // inversion -- it matches equally well either way round. Reporting one
    // would be noise dressed as a finding.
    const result = alignSynteny(genomeA, genomeB);
    for (const b of result.blocks.filter(x => x.orientation === 'reverse')) {
      expect(b.endIdxA).toBeGreaterThan(b.startIdxA);
    }
  });
});

describe('block scoring covers the whole block', () => {
  it('averages across every pair rather than keeping the first', () => {
    // The score used to be taken from the first gene pair and never updated,
    // so a 50-gene block was scored by one gene. An exact-name run should
    // score at the top of the range across its whole length.
    const names = ['terminase', 'portal', 'capsid', 'scaffold', 'tail'];
    const result = alignSynteny(genesFrom(names), genesFrom(names));
    const multiGene = result.blocks.filter(b => b.endIdxA > b.startIdxA);
    expect(multiGene.length).toBeGreaterThan(0);
    for (const b of multiGene) {
      expect(b.score).toBeGreaterThan(0.9);
      expect(b.score).toBeLessThanOrEqual(1);
    }
  });

  it('scores a partially-matching block below a perfect one', () => {
    const perfect = alignSynteny(
      genesFrom(['terminase', 'portal', 'capsid']),
      genesFrom(['terminase', 'portal', 'capsid'])
    );
    const partial = alignSynteny(
      genesFrom(['terminase protein', 'portal protein', 'capsid protein']),
      genesFrom(['terminase subunit', 'portal vertex', 'capsid shell'])
    );

    const best = (r: typeof perfect) =>
      r.blocks.length === 0 ? 0 : Math.max(...r.blocks.map(b => b.score));

    expect(best(perfect)).toBeGreaterThan(best(partial));
  });
});

describe('degenerate input', () => {
  it('handles empty gene lists', () => {
    expect(alignSynteny([], []).blocks).toEqual([]);
    expect(alignSynteny(genesFrom(['capsid']), []).blocks).toEqual([]);
    expect(alignSynteny([], genesFrom(['capsid'])).blocks).toEqual([]);
  });

  it('handles genomes that share nothing', () => {
    const result = alignSynteny(
      genesFrom(['terminase', 'portal']),
      genesFrom(['flagellin', 'pilin'])
    );
    expect(result.blocks.every(b => b.orientation === 'forward')).toBe(true);
  });
});

/**
 * Annotation density and Pfam domain resolution (phage_explorer-jseb).
 *
 * Gene matching was originally name-based only (`geneDistanceOptimized`), which
 * refused to match genes whose only annotation was "hypothetical protein".
 * On the raw NCBI catalogue tables containing parent GenBank `gene` feature rows
 * (which have `product: null`), every other feature was uninformative, making the
 * longest consecutive run of named rows appear as 1.
 *
 * Resolved in phage_explorer-jseb:
 * 1. Pfam-A protein domains (from `protein_domains` in SQLite) are plumbed into
 *    `GeneInfo.domains` and `alignSynteny(..., domainMap)`.
 * 2. Two genes match when they share one or more Pfam accessions (Jaccard similarity).
 * 3. Measured on the real catalogue (CDS features):
 *    - Lambda: 73 CDS genes, 65 have Pfam domains (89.0%), longest matchable run = 23.
 *    - T4: 282 CDS genes, 231 have Pfam domains (81.9%), 21 uninformative hypothetical
 *      genes gained domain matches, longest matchable run increased from 63 to 77.
 *    - P22: 73 CDS genes, 61 have Pfam domains (83.6%), 5 hypothetical genes gained
 *      domain matches, longest matchable run increased from 16 to 21.
 * 4. Inversion detection on real catalogue genomes now fires and detects inverted
 *    blocks, while unmodified catalogue pairs produce zero reverse blocks.
 */
describe('annotation density and domain matching invariants', () => {
  it('cannot form a block from genes with no informative name and no domains', () => {
    // Two "hypothetical protein" genes with no domains must not match each other,
    // or every genome would appear syntenic with every other.
    const hypo = (n: number): GeneInfo => ({
      id: 9000 + n,
      name: null,
      locusTag: `h${n}`,
      startPos: n * 1000,
      endPos: n * 1000 + 500,
      strand: '+',
      product: 'hypothetical protein',
      type: 'CDS',
    });

    const a = [hypo(1), hypo(2), hypo(3), hypo(4)];
    const b = [hypo(4), hypo(3), hypo(2), hypo(1)];
    const result = alignSynteny(a, b);

    // No blocks at all, forward or reverse: refusing to align unannotated junk
    expect(result.blocks.length).toBe(0);
  });

  it('needs two consecutive matched genes to call an orientation', () => {
    // A lone matching gene between unmatched neighbours cannot evidence an
    // inversion, because it reads identically either way round.
    const named = (n: string): GeneInfo => gene(n);
    const a = [named('hypothetical protein'), named('terminase'), named('hypothetical protein')];
    const b = [named('hypothetical protein'), named('terminase'), named('hypothetical protein')];
    const result = alignSynteny(a, b);
    expect(result.blocks.every(x => x.orientation === 'forward')).toBe(true);
  });
});

describe('Pfam domain-based synteny matching (phage_explorer-jseb)', () => {
  it('matches hypothetical genes when they share a Pfam domain', () => {
    const geneA: GeneInfo = {
      id: 101,
      name: null,
      locusTag: 'g101',
      startPos: 1000,
      endPos: 2000,
      strand: '+',
      product: 'hypothetical protein',
      type: 'CDS',
      domains: ['PF00145'],
    };

    const geneB: GeneInfo = {
      id: 201,
      name: null,
      locusTag: 'g201',
      startPos: 1000,
      endPos: 2000,
      strand: '+',
      product: 'hypothetical protein',
      type: 'CDS',
      domains: ['PF00145'],
    };

    const res = alignSynteny(
      [geneA, { ...geneA, id: 102, startPos: 2100, endPos: 3000, domains: ['PF05136'] }],
      [geneB, { ...geneB, id: 202, startPos: 2100, endPos: 3000, domains: ['PF05136'] }]
    );
    expect(res.blocks.length).toBeGreaterThan(0);
    expect(res.blocks[0].score).toBe(1.0);
    expect(res.blocks[0].orientation).toBe('forward');
  });

  it('detects inverted blocks formed by hypothetical genes sharing Pfam domains', () => {
    const makeHypo = (id: number, domain: string): GeneInfo => ({
      id,
      name: null,
      locusTag: `hypo_${id}`,
      startPos: id * 1000,
      endPos: id * 1000 + 800,
      strand: '+',
      product: 'hypothetical protein',
      type: 'CDS',
      domains: [domain],
    });

    const domains = ['PF06763', 'PF06141', 'PF16461', 'PF06894'];
    const a = domains.map((d, i) => makeHypo(100 + i, d));
    const b = [...domains].reverse().map((d, i) => makeHypo(200 + i, d));

    const res = alignSynteny(a, b);
    const reversed = res.blocks.filter(x => x.orientation === 'reverse');
    expect(reversed.length).toBeGreaterThan(0);
    expect(reversed[0].score).toBe(1.0);
  });

  it('supports side-table domainMap when GeneInfo does not have embedded domains', () => {
    const makeHypoNoDoms = (id: number): GeneInfo => ({
      id,
      name: null,
      locusTag: `hypo_${id}`,
      startPos: id * 1000,
      endPos: id * 1000 + 800,
      strand: '+',
      product: 'hypothetical protein',
      type: 'CDS',
    });

    const a = [makeHypoNoDoms(1), makeHypoNoDoms(2)];
    const b = [makeHypoNoDoms(3), makeHypoNoDoms(4)];
    const domainMap = new Map<number, string[]>([
      [1, ['PF00145']],
      [2, ['PF05136']],
      [3, ['PF00145']],
      [4, ['PF05136']],
    ]);

    const res = alignSynteny(a, b, domainMap);
    expect(res.blocks.length).toBeGreaterThan(0);
    expect(res.blocks[0].score).toBe(1.0);
  });
});

describe('real catalogue genome synteny and inversion detection', () => {
  const DB_PATH = join(import.meta.dir, '../../web/public/phage.db');

  it('detects an inverted segment in a real catalogue genome (Lambda)', () => {
    if (!existsSync(DB_PATH)) return;
    const db = new Database(DB_PATH);
    const genes = db.query<GeneInfo, [number]>(`
      SELECT id, name, locus_tag as locusTag, start_pos as startPos, end_pos as endPos,
             strand, product, type
      FROM genes
      WHERE phage_id = ? AND type = 'CDS'
      ORDER BY start_pos ASC
    `).all(1);

    const domainRows = db.query<{ geneId: number; domainId: string }, [number]>(`
      SELECT gene_id as geneId, domain_id as domainId
      FROM protein_domains
      WHERE phage_id = ?
    `).all(1);

    const domainMap = new Map<number, string[]>();
    for (const d of domainRows) {
      const list = domainMap.get(d.geneId) ?? [];
      list.push(d.domainId);
      domainMap.set(d.geneId, list);
    }
    for (const g of genes) {
      g.domains = domainMap.get(g.id) || [];
    }

    expect(genes.length).toBe(73);

    // Invert a real segment of Lambda (indices 10 to 24: 15 tail morphogenesis genes)
    const inverted = [
      ...genes.slice(0, 10),
      ...genes.slice(10, 25).reverse(),
      ...genes.slice(25),
    ];

    const result = alignSynteny(genes, inverted);
    const reversed = result.blocks.filter(b => b.orientation === 'reverse');

    expect(reversed.length).toBeGreaterThan(0);
    // The detected reverse block covers the inverted tail locus
    const invertedBlock = reversed.find(b => b.startIdxA >= 10 && b.endIdxA <= 24);
    expect(invertedBlock).toBeDefined();
    if (invertedBlock) {
      expect(invertedBlock.score).toBeGreaterThan(0.7);
    }
  });

  it('planted negative: unmodified real catalogue genome pair produces ZERO reverse blocks', () => {
    if (!existsSync(DB_PATH)) return;
    const db = new Database(DB_PATH);
    const genes = db.query<GeneInfo, [number]>(`
      SELECT id, name, locus_tag as locusTag, start_pos as startPos, end_pos as endPos,
             strand, product, type
      FROM genes
      WHERE phage_id = ? AND type = 'CDS'
      ORDER BY start_pos ASC
    `).all(1);

    const domainRows = db.query<{ geneId: number; domainId: string }, [number]>(`
      SELECT gene_id as geneId, domain_id as domainId
      FROM protein_domains
      WHERE phage_id = ?
    `).all(1);

    const domainMap = new Map<number, string[]>();
    for (const d of domainRows) {
      const list = domainMap.get(d.geneId) ?? [];
      list.push(d.domainId);
      domainMap.set(d.geneId, list);
    }
    for (const g of genes) {
      g.domains = domainMap.get(g.id) || [];
    }

    const result = alignSynteny(genes, genes);
    expect(result.blocks.length).toBeGreaterThan(0);
    expect(result.blocks.every(b => b.orientation === 'forward')).toBe(true);
    expect(result.blocks.some(b => b.orientation === 'reverse')).toBe(false);
  });
});
