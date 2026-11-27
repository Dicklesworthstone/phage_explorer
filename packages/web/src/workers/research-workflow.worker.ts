/** Private input parsing and CDS analysis stay off the UI thread. No network operations. */
import { importLocalGenomes, type GenomeInput, type LocalGenome, type GenomeImportResult } from '../../../core/src/genome-import';
import { createReferenceCodonExperiment, referenceGenomeFromPhage, type ReferenceCodonOptions } from '../../../core/src/analysis/codon-reference';
import type { AnalysisRecord } from '../../../core/src/analysis-result';
import type { CommandPlan } from '../../../core/src/command-session';
import type { ResearchRecordingResult, ResearchTapeInspection } from '../../../tui/src/research-replay';
import type { ComparisonGenomeInput, GenomeComparisonOptions } from '../../../comparison/src/comparison-experiment';
import type { SyntenyExperimentInput } from '../../../comparison/src/synteny-experiment';

import { createExactRepeatRecord, type ResolvedExactRepeatOptions } from '../../../core/src/analysis/exact-repeat-pairs';
import { createGCSkewRecord, replayGCSkewRecord, type ResolvedGCSkewOptions } from '../../../core/src/analysis/gc-skew';
import { createRestrictionDigestRecord, replayRestrictionDigestRecord, type RestrictionDigestOptions } from '../../../core/src/analysis/restriction-digest';
import { createDotPlotExperiment, createPairwiseDotPlotExperiment } from '../../../core/src/analysis/dot-plot';
import type { MosaicDataset, MosaicRadarConfig } from '../../../core/src/analysis/recombination-radar';
import type { RNAStructureRequest } from '../../../core/src/analysis/rna-structure-experiment';
import type { PangenomePhylogenySource, PhylogenyOptions } from '../../../core/src/analysis/aligned-phylogeny';
import { searchSpacerReferences, createSpacerRecord, type SpacerGenome, type SpacerLibrary,
  type SpacerSearchOptions } from '../../../core/src/analysis/spacer-reference';

export type ResearchWorkerRequest = { type: 'parse'; input: GenomeInput } |
  { type: 'plan-review'; content: string } |
  { type: 'plan-record'; content: string } |
  { type: 'rna'; request: RNAStructureRequest } |
  { type: 'phylogeny'; source: PangenomePhylogenySource; options: PhylogenyOptions } |
  { type: 'spacers'; genome: SpacerGenome; library: SpacerLibrary; options: SpacerSearchOptions } |
  { type: 'mosaic'; dataset: MosaicDataset; options: Required<MosaicRadarConfig> } |
  { type: 'dot-plot'; genome: LocalGenome; comparison: LocalGenome | null; options: { bins: number; window: number } } |
  { type: 'comparison'; genomeA: ComparisonGenomeInput; genomeB: ComparisonGenomeInput; options: GenomeComparisonOptions } |
  { type: 'synteny'; input: SyntenyExperimentInput } |
  { type: 'codons'; genome: LocalGenome; geneId: number | null } |
  { type: 'reference-codons'; genome: LocalGenome; referenceText: string; options: ReferenceCodonOptions } |
  { type: 'gc-skew'; genome: LocalGenome; options: ResolvedGCSkewOptions } |
  { type: 'gc-skew-replay'; content: string } |
  { type: 'restriction-digest'; sequence: string; options: RestrictionDigestOptions; context: { accession: string | null; source: 'local' | 'catalog' } } |
  { type: 'restriction-digest-replay'; content: string } |
  { type: 'exact-repeats'; genome: LocalGenome; options: ResolvedExactRepeatOptions };
export type ResearchWorkerResult = { type: 'parsed'; result: GenomeImportResult } | { type: 'analysis'; record: AnalysisRecord } |
  { type: 'plan-reviewed'; plan: CommandPlan; genomes: ResearchTapeInspection['genomes'] } |
  { type: 'plan-recorded'; result: ResearchRecordingResult & { allResultsJson: string } };

export async function executeResearchRequest(request: ResearchWorkerRequest): Promise<ResearchWorkerResult> {
  if (request.type === 'plan-review') {
    // This host uses the same canonical adapters as native recording and has no
    // filesystem, renderer or network dependencies. Review computes no analysis.
    const { validateResearchPlan } = await import('../../../tui/src/research-replay');
    const plan = validateResearchPlan(request.content);
    const context = plan.context as { bundle: string };
    const parsed = await importLocalGenomes({ name: 'workflow-genomes.json', text: context.bundle });
    return { type: 'plan-reviewed', plan, genomes: parsed.genomes.map(genome => ({
      contentId: genome.phage.localGenome!.contentId, accession: genome.phage.accession,
      bases: genome.sequence.length, mappedFeatures: genome.phage.genes.length,
    })) };
  }
  if (request.type === 'plan-record') {
    // Run the existing isolated authoring host off-thread. It validates the
    // whole plan first and returns no partial tape/archive on failure. Aborting
    // runResearchWorker terminates this worker, including synchronous CPU work.
    const { recordResearchPlan } = await import('../../../tui/src/research-replay');
    const result = await recordResearchPlan(request.content, { captureResults: true });
    if (result.allResultsJson === undefined) throw new Error('The command plan did not produce complete results.');
    return { type: 'plan-recorded', result: { ...result, allResultsJson: result.allResultsJson } };
  }
  if (request.type === 'parse') return { type: 'parsed', result: await importLocalGenomes(request.input) };
  if (request.type === 'comparison') {
    const { createGenomeComparisonExperiment } = await import('../../../comparison/src/comparison-experiment');
    return { type: 'analysis', record: (await createGenomeComparisonExperiment(request.genomeA, request.genomeB, request.options)).record };
  }
  if (request.type === 'synteny') {
    const { analyzeSyntenyExperiment } = await import('../../../comparison/src/synteny-experiment');
    return { type: 'analysis', record: (await analyzeSyntenyExperiment(request.input)).record };
  }
  if (request.type === 'phylogeny') {
    const { createPangenomePhylogenyExperiment } = await import('../../../core/src/analysis/aligned-phylogeny');
    return { type: 'analysis', record: (await createPangenomePhylogenyExperiment(request.source, request.options)).record };
  }
  if (request.type === 'rna') {
    const { executeRNAStructureRequest } = await import('../../../core/src/analysis/rna-structure-experiment');
    return { type: 'analysis', record: (await executeRNAStructureRequest(request.request)).record };
  }
  if (request.type === 'spacers') {
    const result = searchSpacerReferences(request.genome, request.library, request.options);
    return { type: 'analysis', record: await createSpacerRecord(request.genome, request.library, result) };
  }
  if (request.type === 'mosaic') {
    const { createMosaicExperiment } = await import('../../../core/src/analysis/recombination-radar');
    return { type: 'analysis', record: (await createMosaicExperiment(request.dataset, request.options)).record };
  }
  if (request.type === 'dot-plot') {
    const input = (genome: LocalGenome) => ({ sequence: genome.sequence, accession: genome.phage.accession, source: 'local' as const });
    const result = request.comparison === null
      ? await createDotPlotExperiment(input(request.genome), request.options)
      : await createPairwiseDotPlotExperiment(input(request.genome), input(request.comparison), request.options);
    return { type: 'analysis', record: result.record };
  }
  if (request.type === 'restriction-digest') return { type: 'analysis', record: await createRestrictionDigestRecord(request.sequence, request.options, request.context) };
  if (request.type === 'restriction-digest-replay') return { type: 'analysis', record: await replayRestrictionDigestRecord(request.content) };
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
