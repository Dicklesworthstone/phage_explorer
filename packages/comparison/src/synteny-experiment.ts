/** Portable annotation-order comparisons. No sequence homology or rearrangement inference. */
import type { GeneInfo } from '@phage-explorer/core';
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, type AnalysisInput, type AnalysisJson,
  type AnalysisRecord } from '../../core/src/analysis-result';
import { alignSynteny, buildSyntenyHeatmap, type SyntenyAnalysis, type SyntenyBlock } from './synteny';

export const SYNTENY_EXPERIMENT_METHOD = {
  id: 'annotation-order-synteny', version: '1.0.0',
  implementation: 'Phage Explorer annotation-distance DTW, reversed-order and local reverse-chain search',
} as const;
export const SYNTENY_EXPERIMENT_PARAMETERS = {
  order: 'supplied', similarity: 'informative-name-or-domain-jaccard', matchDistanceBelow: 0.8,
  matrixPrecision: 'float32', reverseMinimumGenes: 2, coordinateConvention: 'zero-based-half-open',
} as const;
export const SYNTENY_EXPERIMENT_LIMITS = { genes: 2000, cells: 500000, inputBytes: 2 * 1024 * 1024 } as const;
export const SYNTENY_EXPERIMENT_LIMITATIONS = [
  'Similarity uses informative product/name tokens and supplied domain identifiers; it does not align nucleotide or protein sequences or establish homology.',
  'Annotation rows remain in their supplied order. Gene/CDS duplicates, annotation omissions and repeated labels can change the result. Locus tags alone are not matching evidence.',
  'Forward and reverse blocks are heuristic annotation-order matches. Breakpoint labels are not validated inversions, translocations, indels, evolutionary relationships or event counts.',
  'Block spans include intervening bases, not aligned sequence coverage. The forward DTW cost is unnormalized and depends on both annotation counts.',
  'Original annotation coordinates, labels, domains and source metadata are embedded; genome bases, external files and unprovided annotation releases are not reconstructed.',
] as const;

export interface SyntenyGenomeDescriptor {
  id: number;
  name: string;
  accession: string | null;
  length: number;
  source: AnalysisInput['source'];
  contentId: string | null;
  annotationMetadata: AnalysisJson;
}
export interface SyntenyExperimentInput {
  query: SyntenyGenomeDescriptor;
  reference: SyntenyGenomeDescriptor;
  genesQuery: GeneInfo[];
  genesReference: GeneInfo[];
}
export interface SyntenyBlockBp {
  startIdxQuery: number;
  endIdxQuery: number;
  startIdxReference: number;
  endIdxReference: number;
  startBpQuery: number;
  endBpQuery: number;
  startBpReference: number;
  endBpReference: number;
  score: number;
  orientation: SyntenyBlock['orientation'];
}
export interface SyntenyStats {
  blockCount: number;
  globalScore: number;
  scsScore: number;
  dtwDistance: number;
  coverageQuery: number;
  coverageReference: number;
  inversionCount: number;
  translocationCount: number;
  indelCount: number;
}
export interface SyntenyExperimentResult {
  analysis: SyntenyAnalysis;
  blocksBp: SyntenyBlockBp[];
  heatmap: { rows: number; cols: number; values: number[]; min: number; max: number };
  stats: SyntenyStats;
}
export interface SyntenyExperiment {
  input: SyntenyExperimentInput;
  result: SyntenyExperimentResult;
  record: AnalysisRecord;
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum: number, nullable = false): boolean => nullable && value === null
  || typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const label = (value: unknown, maximum: number): boolean => value === null || typeof value === 'string' && value.length <= maximum;

/** Snapshot every annotation before asynchronous work. Do not sort, filter or deduplicate. */
export function validateSyntenyInput(value: unknown): SyntenyExperimentInput {
  if (!object(value) || Object.keys(value).some(key => !['query', 'reference', 'genesQuery', 'genesReference'].includes(key))) {
    throw new Error('Synteny requires two explicit annotation sources and no unsupported top-level settings.');
  }
  for (const [role, geneKey] of [['query', 'genesQuery'], ['reference', 'genesReference']] as const) {
    const genome = value[role], genes = value[geneKey];
    if (!object(genome) || !Number.isSafeInteger(genome.id) || !text(genome.name, 500)
      || !text(genome.accession, 500, true) || typeof genome.source !== 'string' || !['catalog', 'local', 'external', 'demo'].includes(genome.source)
      || !text(genome.contentId, 500, true) || !Object.hasOwn(genome, 'annotationMetadata') || genome.annotationMetadata === undefined) {
      throw new Error('The ' + role + ' annotation source is incomplete.');
    }
    if (!Number.isSafeInteger(genome.length) || Number(genome.length) < 1) {
      throw new Error('The ' + role + ' genome needs its complete positive integer length for coordinate coverage.');
    }
    if (!Array.isArray(genes) || genes.length < 1 || genes.length > SYNTENY_EXPERIMENT_LIMITS.genes) {
      throw new Error('The ' + role + ' needs 1–' + SYNTENY_EXPERIMENT_LIMITS.genes + ' annotation rows.');
    }
    const ids = new Set<number>();
    for (const [index, gene] of genes.entries()) {
      if (!object(gene) || !Number.isSafeInteger(gene.id) || ids.has(Number(gene.id))
        || !Number.isSafeInteger(gene.startPos) || !Number.isSafeInteger(gene.endPos)
        || Number(gene.startPos) < 0 || Number(gene.endPos) <= Number(gene.startPos) || Number(gene.endPos) > Number(genome.length)
        || !label(gene.name, 2000) || !label(gene.product, 10000) || !label(gene.locusTag, 1000)
        || !label(gene.type, 200) || !label(gene.strand, 32)
        || gene.domains !== undefined && (!Array.isArray(gene.domains) || gene.domains.length > 100 || gene.domains.some(domain => !text(domain, 200)))
        || gene.qualifiers !== undefined && gene.qualifiers !== null && !object(gene.qualifiers)) {
        throw new Error('Invalid ' + role + ' annotation at index ' + index + ': check IDs, coordinates, labels and domains.');
      }
      ids.add(Number(gene.id));
    }
  }
  const input = value as unknown as SyntenyExperimentInput;
  if (input.genesQuery.length * input.genesReference.length > SYNTENY_EXPERIMENT_LIMITS.cells) {
    throw new Error('Synteny exceeds the 500,000-cell comparison limit. Supply smaller annotation sets.');
  }
  const snapshot = analysisJson(input);
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > SYNTENY_EXPERIMENT_LIMITS.inputBytes) {
    throw new Error('Synteny annotation sources exceed 2 MiB. Supply smaller annotation sets.');
  }
  return snapshot as unknown as SyntenyExperimentInput;
}

function intervalUnion(segments: Array<{ start: number; end: number }>): number {
  const ordered = [...segments].sort((a, b) => a.start - b.start || a.end - b.end);
  let total = 0, end = 0;
  for (const segment of ordered) {
    total += Math.max(0, segment.end - Math.max(segment.start, end));
    end = Math.max(end, segment.end);
  }
  return total;
}
function blocksInBases(analysis: SyntenyAnalysis, input: SyntenyExperimentInput): SyntenyBlockBp[] {
  return analysis.blocks.map(block => {
    const a = input.genesQuery.slice(block.startIdxA, block.endIdxA + 1);
    const b = input.genesReference.slice(block.startIdxB, block.endIdxB + 1);
    return { startIdxQuery: block.startIdxA, endIdxQuery: block.endIdxA,
      startIdxReference: block.startIdxB, endIdxReference: block.endIdxB,
      startBpQuery: Math.min(...a.map(gene => gene.startPos)), endBpQuery: Math.max(...a.map(gene => gene.endPos)),
      startBpReference: Math.min(...b.map(gene => gene.startPos)), endBpReference: Math.max(...b.map(gene => gene.endPos)),
      score: block.score, orientation: block.orientation };
  });
}

export async function analyzeSyntenyExperiment(value: unknown): Promise<SyntenyExperiment> {
  const input = validateSyntenyInput(value);
  const analysis = alignSynteny(input.genesQuery, input.genesReference);
  const matrix = buildSyntenyHeatmap(input.genesQuery, input.genesReference);
  const blocksBp = blocksInBases(analysis, input);
  const stats: SyntenyStats = {
    blockCount: blocksBp.length, globalScore: analysis.globalScore, scsScore: analysis.scsScore, dtwDistance: analysis.dtwDistance,
    coverageQuery: intervalUnion(blocksBp.map(block => ({ start: block.startBpQuery, end: block.endBpQuery }))),
    coverageReference: intervalUnion(blocksBp.map(block => ({ start: block.startBpReference, end: block.endBpReference }))),
    inversionCount: analysis.breakpointDetails.filter(row => row.type === 'inversion').length,
    translocationCount: analysis.breakpointDetails.filter(row => row.type === 'translocation').length,
    indelCount: analysis.breakpointDetails.filter(row => row.type === 'indel').length,
  };
  const result: SyntenyExperimentResult = { analysis, blocksBp, stats, heatmap: { ...matrix, values: Array.from(matrix.values) } };
  const record = await createAnalysisRecord({ method: SYNTENY_EXPERIMENT_METHOD,
    inputs: (['query', 'reference'] as const).map(role => ({ id: role, source: input[role].source, accession: input[role].accession,
      description: (role === 'query' ? 'Query' : 'Reference') + ': exact ordered annotations for ' + input[role].name + '; no genome bases included',
      data: analysisJson({ genome: input[role], genes: role === 'query' ? input.genesQuery : input.genesReference }) })),
    parameters: SYNTENY_EXPERIMENT_PARAMETERS,
    seed: null, references: [], fields: {
      synteny: { label: 'Complete annotation-order comparison', kind: 'sequence-score', units: 'records', value: analysisJson(result),
        coverage: { available: input.genesQuery.length + input.genesReference.length,
          total: input.genesQuery.length + input.genesReference.length, unit: 'genes' },
        limitations: [...SYNTENY_EXPERIMENT_LIMITATIONS] },
    } });
  return { input, result, record };
}

/** Integrity alone is insufficient: even self-consistently modified results must be recomputed. */
export async function replaySyntenyExperiment(content: string): Promise<SyntenyExperiment> {
  const saved = await parseAnalysisRecord(content, { methodId: SYNTENY_EXPERIMENT_METHOD.id, methodVersion: SYNTENY_EXPERIMENT_METHOD.version });
  if (saved.inputs.length !== 2 || saved.inputs[0].id !== 'query' || saved.inputs[1].id !== 'reference') {
    throw new Error('A synteny experiment requires its original query and reference annotations.');
  }
  const query = saved.inputs[0].data, reference = saved.inputs[1].data;
  if (!object(query) || !object(reference)) throw new Error('Synteny source annotations are missing.');
  const replay = await analyzeSyntenyExperiment({ query: query.genome, reference: reference.genome,
    genesQuery: query.genes, genesReference: reference.genes });
  if (replay.record.cacheKey !== saved.cacheKey || replay.record.resultId !== saved.resultId) {
    throw new Error('Saved synteny evidence differs from the freshly recomputed experiment.');
  }
  return replay;
}

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  const text = String(value).replace(/[\t\r\n]/g, ' ');
  // Text columns remain text when opened by spreadsheet applications.
  return typeof value === 'string' && /^[=+@-]/.test(text) ? "'" + text : text;
};
export type SyntenyTable = 'blocks' | 'matrix' | 'annotations';
/** All rows, not just a visible viewport. JSON retains exact original whitespace. */
export function exportSyntenyTsv(experiment: SyntenyExperiment, table: SyntenyTable): string {
  const { input, result, record } = experiment;
  const lines = ['# method\t' + record.method.id + '\t' + record.method.version, '# result_id\t' + record.resultId,
    '# query\t' + cell(input.query.name) + '\t' + cell(input.query.accession),
    '# reference\t' + cell(input.reference.name) + '\t' + cell(input.reference.accession),
    '# Annotation-order heuristic; not sequence identity or validated rearrangement calls.'];
  const row = (values: unknown[]) => { lines.push(values.map(cell).join('\t')); };
  if (table === 'blocks') {
    row(['block_index', 'query_start_index', 'query_end_index_inclusive', 'reference_start_index', 'reference_end_index_inclusive',
      'query_start_bp', 'query_end_bp_exclusive', 'reference_start_bp', 'reference_end_bp_exclusive', 'orientation', 'annotation_similarity']);
    result.blocksBp.forEach((block, index) => row([index, block.startIdxQuery, block.endIdxQuery, block.startIdxReference,
      block.endIdxReference, block.startBpQuery, block.endBpQuery, block.startBpReference, block.endBpReference, block.orientation, block.score]));
  } else if (table === 'matrix') {
    row(['query_index', 'reference_index', 'query_gene_id', 'reference_gene_id', 'annotation_similarity']);
    for (let i = 0; i < input.genesQuery.length; i++) {
      for (let j = 0; j < input.genesReference.length; j++) row([i, j, input.genesQuery[i].id,
        input.genesReference[j].id, result.heatmap.values[i * result.heatmap.cols + j]]);
    }
  } else if (table === 'annotations') {
    row(['role', 'index', 'accession', 'gene_id', 'name', 'locus_tag', 'product', 'type', 'strand', 'start_bp', 'end_bp_exclusive', 'domains', 'qualifiers_json']);
    for (const role of ['query', 'reference'] as const) (role === 'query' ? input.genesQuery : input.genesReference).forEach((gene, index) =>
      row([role, index, input[role].accession, gene.id, gene.name, gene.locusTag, gene.product, gene.type,
        gene.strand, gene.startPos, gene.endPos, gene.domains?.join(';') ?? '', gene.qualifiers ? JSON.stringify(gene.qualifiers) : '']));
  } else throw new Error('Unsupported synteny table.');
  return lines.join('\n') + '\n';
}
