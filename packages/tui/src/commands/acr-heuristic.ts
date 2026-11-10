/** Optional legacy size/charge shortlist, kept separate from sourced spacer evidence. */
import { analyzeCRISPRPressure } from '../../../core/src/crispr';
import { validateSpacerGenome, type SpacerGenome } from '../../../core/src/analysis/spacer-reference';
import type { GeneInfo } from '../../../core/src/types';

export interface TerminalAcrRequest { kind: 'acr'; genome: SpacerGenome; genes: GeneInfo[] }
export interface TerminalAcrResult {
  genome: Omit<SpacerGenome, 'sequence'> & { length: number };
  submittedGenes: number;
  eligibleGenes: number;
  skipped: Record<string, number>;
  candidates: Array<{ geneId: number; geneName: string | null; score: number;
    start: number; end: number; strand: string; translatedCodons: number }>;
}
export type TerminalAcrMessage = { kind: 'progress'; phase: string }
  | { kind: 'acr-result'; value: TerminalAcrResult } | { kind: 'error'; message: string };

/** Preserve the existing scorer on its supported input; never flatten a compound CDS. */
export function executeTerminalAcrHeuristic(request: TerminalAcrRequest): TerminalAcrResult {
  const genome = validateSpacerGenome(request.genome);
  if (!Array.isArray(request.genes) || request.genes.length > 10000) {
    throw new Error('The Acr heuristic accepts at most 10,000 annotated genes.');
  }
  const genes: GeneInfo[] = [], ids = new Set<number>(), skipped: Record<string, number> = {};
  const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
  for (const gene of request.genes) {
    if (!gene || !Number.isSafeInteger(gene.id) || ids.has(gene.id)) throw new Error('Acr annotations require unique integer gene IDs.');
    ids.add(gene.id);
    if (gene.type !== 'CDS') { skip('Non-CDS annotation'); continue; }
    if (!Number.isSafeInteger(gene.startPos) || !Number.isSafeInteger(gene.endPos) || gene.startPos < 0
      || gene.endPos <= gene.startPos || gene.endPos > genome.sequence.length || !['+', '-'].includes(gene.strand ?? '')) {
      skip('Invalid, wrapped or unoriented interval'); continue;
    }
    const q = gene.qualifiers ?? {};
    if (q._segments !== undefined
      || (typeof q._location === 'string' && /[<>:]|join\(|order\(/i.test(q._location))
      || ['partial', 'pseudo', 'pseudogene', 'exception', 'transl_except', 'ribosomal_slippage'].some(key => q[key] !== undefined)
      || (q.codon_start !== undefined && String(q.codon_start) !== '1')
      || (q.transl_table !== undefined && !['1', '11'].includes(String(q.transl_table)))) {
      skip('Compound, partial or exceptional translation annotation'); continue;
    }
    if ((gene.endPos - gene.startPos) % 3 !== 0) { skip('Incomplete codon interval'); continue; }
    // The legacy scorer translates complete codons before its 50–200-aa size rule.
    const codons = Math.floor((gene.endPos - gene.startPos) / 3);
    if (codons < 50 || codons > 200) { skip('Outside the legacy 50–200-codon size range'); continue; }
    if (/[^ACGT]/.test(genome.sequence.slice(gene.startPos, gene.endPos))) {
      skip('Ambiguous DNA in the annotated span'); continue;
    }
    genes.push(gene);
  }
  // At most 6,020,000 annotated bases are translated, in a cancellable native worker.
  const byId = new Map(genes.map(gene => [gene.id, gene]));
  const candidates = analyzeCRISPRPressure(genome.sequence, genes).acrCandidates.map(candidate => {
    const gene = byId.get(candidate.geneId)!;
    return { geneId: candidate.geneId, geneName: candidate.geneName, score: candidate.score,
      start: gene.startPos, end: gene.endPos, strand: gene.strand!,
      translatedCodons: Math.floor((gene.endPos - gene.startPos) / 3) };
  });
  const { sequence, ...identity } = genome;
  return { genome: { ...identity, length: sequence.length }, submittedGenes: request.genes.length,
    eligibleGenes: genes.length, skipped, candidates };
}
