/** Private input parsing and CDS analysis stay off the UI thread. No network operations. */
import { importLocalGenomes, type GenomeInput, type LocalGenome, type GenomeImportResult } from '../../../core/src/genome-import';
import { createReferenceCodonExperiment, referenceGenomeFromPhage, type ReferenceCodonOptions } from '../../../core/src/analysis/codon-reference';
import type { AnalysisRecord } from '../../../core/src/analysis-result';

import { createExactRepeatRecord, type ResolvedExactRepeatOptions } from '../../../core/src/analysis/exact-repeat-pairs';
import { createGCSkewRecord, replayGCSkewRecord, type ResolvedGCSkewOptions } from '../../../core/src/analysis/gc-skew';

export type ResearchWorkerRequest = { type: 'parse'; input: GenomeInput } |
  { type: 'codons'; genome: LocalGenome; geneId: number | null } |
  { type: 'reference-codons'; genome: LocalGenome; referenceText: string; options: ReferenceCodonOptions } |
  { type: 'gc-skew'; genome: LocalGenome; options: ResolvedGCSkewOptions } |
  { type: 'gc-skew-replay'; content: string } |
  { type: 'exact-repeats'; genome: LocalGenome; options: ResolvedExactRepeatOptions };
export type ResearchWorkerResult = { type: 'parsed'; result: GenomeImportResult } | { type: 'analysis'; record: AnalysisRecord };

export async function executeResearchRequest(request: ResearchWorkerRequest): Promise<ResearchWorkerResult> {
  if (request.type === 'parse') return { type: 'parsed', result: await importLocalGenomes(request.input) };
  if (request.type === 'gc-skew-replay') return { type: 'analysis', record: await replayGCSkewRecord(request.content) };
  if (request.type === 'gc-skew') return { type: 'analysis', record: await createGCSkewRecord(request.genome.sequence, request.options,
    { accession: request.genome.phage.accession, source: 'local' }) };
  if (request.type === 'reference-codons') return { type: 'analysis', record: (await createReferenceCodonExperiment(
    referenceGenomeFromPhage(request.genome.phage), request.genome.sequence, request.referenceText, request.options)).record };
  if (request.type === 'exact-repeats') return { type: 'analysis', record: await createExactRepeatRecord(
    request.genome.sequence, request.options, { accession: request.genome.phage.accession, source: 'local' }) };
  if (request.type !== 'codons') throw new Error('Unsupported research worker operation.');
  // Reference-backed runs must not initialize or substitute the illustrative model.
  const { analyzePhageHostCodonAdaptation, createCodonAdaptationRecord } = await import('../../../core/src/analysis/codon-pair-adaptation');
  const phage = structuredClone(request.genome.phage);
  phage.genes = phage.genes.filter(gene => gene.type === 'CDS' && (request.geneId === null || gene.id === request.geneId));
  if (!phage.genes.length) throw new Error('No supported CDS annotations are available for this command.');
  // The existing parser/analysis preserves complement(), join(), codon_start and genetic-code qualifiers.
  phage.codonUsage = null;
  const analysis = analyzePhageHostCodonAdaptation(phage, { genomeSequence: request.genome.sequence });
  return { type: 'analysis', record: await createCodonAdaptationRecord(phage, request.genome.sequence, analysis) };
}

// This producer is also imported by native hosts. Describe only the worker
// endpoint we use so importing it does not require DOM globals or browser libs.
type WorkerResponse = { type: 'result'; result: ResearchWorkerResult } | { type: 'error'; message: string };
const scope = globalThis as unknown as {
  document?: unknown;
  postMessage?: (response: WorkerResponse) => void;
  onmessage?: ((event: { data: ResearchWorkerRequest }) => void) | null;
};
if (scope.document === undefined && typeof scope.postMessage === 'function') {
  const post = scope.postMessage.bind(scope);
  scope.onmessage = event => {
    void executeResearchRequest(event.data)
      .then(result => post({ type: 'result', result }))
      .catch((cause: unknown) => post({ type: 'error', message: cause instanceof Error ? cause.message : 'Research worker failed.' }));
  };
}
