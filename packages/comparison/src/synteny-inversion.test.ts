import { describe, expect, it } from 'bun:test';
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
 * The limitation, recorded so it is not mistaken for a working feature.
 *
 * The detection above is correct — the synthetic tests plant an inversion and
 * it is found. On the SHIPPED CATALOGUE it will essentially never fire, and
 * that is worth stating plainly rather than leaving for someone to discover.
 *
 * Gene matching is name-based (`geneDistanceOptimized`), and it deliberately
 * refuses to match genes whose only annotation is "hypothetical protein",
 * because aligning those would be noise. But 62-69% of genes in the catalogue
 * are exactly that: lambda 108/174, T4 399/582, P22 118/181. Measured on
 * lambda, the longest run of CONSECUTIVE informatively-named genes is one.
 *
 * A block needs at least two consecutive matched genes to carry orientation, so
 * with real annotations there is nothing for the reverse pass to build on. This
 * was verified directly: inverting a real 30-gene segment of lambda and
 * re-aligning finds zero inverted blocks.
 *
 * The fix is a stronger gene-similarity signal, not a change to this algorithm.
 * The database now ships 1,695 Pfam-A domain hits, which annotate many genes
 * that carry no useful product name; matching on shared domains would give the
 * reverse pass something to work with. Tracked separately.
 */
describe('known limitation: annotation density, not the algorithm', () => {
  it('cannot form a block from genes with no informative name', () => {
    // Two "hypothetical protein" genes must not match each other, or every
    // genome would appear syntenic with every other.
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

    // No blocks at all, forward or reverse: correct, and the reason inversion
    // detection is data-limited on the real catalogue.
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
