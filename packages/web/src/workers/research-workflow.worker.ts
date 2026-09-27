/** Private input parsing and CDS analysis stay off the UI thread. No network operations. */
import { importLocalGenomes, analyzePhageHostCodonAdaptation, createCodonAdaptationRecord,
  type GenomeInput, type LocalGenome, type GenomeImportResult, type AnalysisRecord } from '@phage-explorer/core';

export type ResearchWorkerRequest = { type: 'parse'; input: GenomeInput } |
  { type: 'codons'; genome: LocalGenome; geneId: number | null };
export type ResearchWorkerResult = { type: 'parsed'; result: GenomeImportResult } | { type: 'analysis'; record: AnalysisRecord };

export async function executeResearchRequest(request: ResearchWorkerRequest): Promise<ResearchWorkerResult> {
  if (request.type === 'parse') return { type: 'parsed', result: await importLocalGenomes(request.input) };
  if (request.type !== 'codons') throw new Error('Unsupported research worker operation.');
  const phage = structuredClone(request.genome.phage);
  phage.genes = phage.genes.filter(gene => gene.type === 'CDS' && (request.geneId === null || gene.id === request.geneId));
  if (!phage.genes.length) throw new Error('No supported CDS annotations are available for this command.');
  // The existing parser/analysis preserves complement(), join(), codon_start and genetic-code qualifiers.
  phage.codonUsage = null;
  const analysis = analyzePhageHostCodonAdaptation(phage, { genomeSequence: request.genome.sequence });
  return { type: 'analysis', record: await createCodonAdaptationRecord(phage, request.genome.sequence, analysis) };
}

if (typeof self !== 'undefined' && typeof document === 'undefined') self.onmessage = (event: MessageEvent<ResearchWorkerRequest>) => {
  void executeResearchRequest(event.data)
    .then(result => self.postMessage({ type: 'result', result }))
    .catch((cause: unknown) => self.postMessage({ type: 'error', message: cause instanceof Error ? cause.message : 'Research worker failed.' }));
};
