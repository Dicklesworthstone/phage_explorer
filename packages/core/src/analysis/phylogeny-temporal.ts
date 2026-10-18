/** An alignment-backed dated-tree workflow, not a new temporal estimator. */
import { analysisJson, createAnalysisRecord, parseAnalysisRecord, serializeAnalysisRecord, type AnalysisRecord } from '../analysis-result';
import { replayRootedPhylogenyExperiment } from './phylogeny-rooting';
import { createDatedTreeRecord, fitDatedTree, resolveDatingOptions, type DatingOptions, type DatedTreeResult } from './strict-clock';
import { analyzeTemporalSignal, createTemporalRecord, parseTemporalSampleTable, resolveTemporalOptions,
  validateTemporalDataset, TEMPORAL_LIMITS, type TemporalDataset, type TemporalOptions, type TemporalResult } from './temporal-signal';

export const ROOTED_TEMPORAL_METHOD = { id: 'rooted-nj-temporal-signal', version: '1.0.0', implementation: 'typescript' } as const;
export interface RootedTemporalMetadata {
  name: string;
  kind: 'local' | 'demo';
  description: string;
  reference: string | null;
  license: string;
  sampleTable: string;
  /** Also covers alignment/cohort selection, not just the numerical NJ operation. */
  dateIndependent: true;
}
export interface RootedTemporalSource { content: string; metadata: RootedTemporalMetadata }
export interface PreparedRootedTemporal {
  dataset: TemporalDataset;
  rootedSource: RootedTemporalSource;
  rootedResultId: string;
  unrootedResultId: string;
}
export interface RootedTemporalExperiment extends PreparedRootedTemporal {
  result: TemporalResult;
  record: AnalysisRecord;
}
const active = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new DOMException('Rooted temporal workflow cancelled.', 'AbortError');
};
function snapshotMetadata(value: RootedTemporalMetadata): RootedTemporalMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== 'dateIndependent|description|kind|license|name|reference|sampleTable') {
    throw new Error('Supply dated-cohort name, kind, description, reference, license, sampleTable and dateIndependent.');
  }
  if (value.dateIndependent !== true) throw new Error('Declare that alignment/cohort selection, tree inference and rooting did not use collection dates.');
  if (value.kind !== 'local' && value.kind !== 'demo') throw new Error('Declare local or demo collection-date provenance.');
  if (typeof value.sampleTable !== 'string' || value.sampleTable.length > TEMPORAL_LIMITS.bytes
    || new TextEncoder().encode(value.sampleTable).length > TEMPORAL_LIMITS.bytes) throw new Error('Sample metadata exceeds the 2 MiB limit.');
  for (const [key, item] of Object.entries(value)) {
    if (!['name', 'description', 'reference', 'license'].includes(key) || key === 'reference' && item === null) continue;
    if (typeof item !== 'string' || !item.trim() || new TextEncoder().encode(item).length > 2000 || /[\u0000-\u001f\u007f-\u009f]/.test(item)) {
      throw new Error(`Dated-cohort ${key} requires 1–2000 UTF-8 bytes without control characters.`);
    }
  }
  // All fields are scalars: retain the exact supplied CSV/TSV and provenance.
  return { ...value };
}

/** Recompute the parent before deriving its dated tree. Neither Newick nor dates can override the parent. */
export async function prepareRootedTemporalDataset(content: string, supplied: RootedTemporalMetadata,
  signal?: AbortSignal): Promise<PreparedRootedTemporal> {
  active(signal);
  const metadata = snapshotMetadata(supplied);
  if (typeof content !== 'string' || content.length > 10 * 1024 * 1024
    || new TextEncoder().encode(content).length > 10 * 1024 * 1024) throw new Error('Rooted phylogeny exceeds the 10 MiB limit.');
  const samples = parseTemporalSampleTable(metadata.sampleTable);
  const rooted = await replayRootedPhylogenyExperiment(content.replace(/^\uFEFF/, ''), signal);
  active(signal);
  if (rooted.unrooted.options.distance !== 'jc69') {
    throw new Error('Temporal handoff requires a JC69 phylogeny. Re-infer with JC69 and explicitly root it; p-distance branches are not silently relabeled as substitutions/site.');
  }
  const rootedResultId = rooted.record.resultId, unrootedResultId = rooted.unrooted.record.resultId;
  const dataset = validateTemporalDataset({ format: 'phage-explorer-temporal-signal', version: 1, name: metadata.name,
    source: { kind: rooted.unrooted.source.kind === 'demo' || metadata.kind === 'demo' ? 'demo' : 'local',
      description: metadata.description, reference: metadata.reference, license: metadata.license },
    tree: { newick: rooted.result.newick, units: 'substitutions/site', inferredWithoutDates: true,
      method: `JC69 neighbor joining ${rooted.unrooted.record.method.version}; fixed branches, no clock calibration`,
      rooting: `User-specified outgroup hypothesis ${rootedResultId}; ${rooted.result.rooting.outgroup.length} outgroup tips; fraction ${rooted.result.rooting.fractionFromOutgroup} from the outgroup endpoint. Full decision retained in the parent record.`,
      alignmentProvenance: `Original alignment and provenance retained in parent ${rootedResultId}; unrooted inference ${unrootedResultId}. Date-independence of input selection is user-declared, not independently verified.` }, samples });
  active(signal);
  return { dataset, rootedResultId, unrootedResultId,
    rootedSource: { content: serializeAnalysisRecord(rooted.record), metadata } };
}

/** One portable record retains the alignment, root decision, original sample table and diagnostic settings. */
export async function createRootedTemporalExperiment(content: string, metadata: RootedTemporalMetadata,
  supplied: Partial<TemporalOptions> = {}, signal?: AbortSignal): Promise<RootedTemporalExperiment> {
  active(signal);
  const options = resolveTemporalOptions(supplied); // Snapshot exclusions before the first await.
  const prepared = await prepareRootedTemporalDataset(content, metadata, signal);
  active(signal);
  const result = analyzeTemporalSignal(prepared.dataset, options);
  const parent = JSON.parse(prepared.rootedSource.content) as AnalysisRecord; // Produced by verified replay above.
  result.warnings.push(
    'The entire alignment/root/metadata chain is retained and recomputed on replay. This verifies reproducibility, not homology, root accuracy, sampling independence or collection-date truth.',
    'Alignment/cohort selection and rooting must not have used dates. This is a user declaration, not an automatically verified study-design property.',
    ...parent.fields.rooting.limitations,
  );
  const diagnostic = await createTemporalRecord(prepared.dataset, result);
  active(signal);
  const record = await createAnalysisRecord({ method: ROOTED_TEMPORAL_METHOD,
    inputs: [...diagnostic.inputs.map(({ sha256: _sha, ...input }) => input),
      { id: 'rootedPhylogeny', accession: null, source: parent.inputs[0].source, description: 'Verified parent with original aligned DNA, inference settings and explicit rooting evidence', data: analysisJson(parent) },
      { id: 'collectionMetadata', accession: null, source: prepared.rootedSource.metadata.kind, description: 'Original collection-date table, provenance and study-design declaration', data: analysisJson(prepared.rootedSource.metadata) }],
    parameters: analysisJson(options) as AnalysisRecord['parameters'], seed: options.seed,
    references: [...parent.references, ...diagnostic.references],
    fields: { ...diagnostic.fields, lineage: { kind: 'sequence-score', label: 'Recomputed parent and diagnostic identities', units: 'records',
      value: { rootedResultId: prepared.rootedResultId, unrootedResultId: prepared.unrootedResultId, diagnosticResultId: diagnostic.resultId },
      coverage: { available: result.tips.length, total: result.tips.length, unit: 'records' }, limitations: result.warnings } } });
  active(signal);
  return { ...prepared, result, record };
}

/** Hash-valid substituted trees/results still fail: derive the tree and every diagnostic again. */
export async function replayRootedTemporalExperiment(content: string, signal?: AbortSignal): Promise<RootedTemporalExperiment> {
  active(signal);
  const saved = await parseAnalysisRecord(content, { methodId: ROOTED_TEMPORAL_METHOD.id, methodVersion: ROOTED_TEMPORAL_METHOD.version });
  active(signal);
  if (saved.inputs.length !== 3 || saved.inputs.map(input => input.id).join('|') !== 'datedTree|rootedPhylogeny|collectionMetadata'
    || Object.keys(saved.parameters).sort().join('|') !== 'excludedSamples|permutationScheme|permutations|seed') {
    throw new Error('Rooted temporal replay requires the parent, dated tree, original metadata and every explicit diagnostic option.');
  }
  const experiment = await createRootedTemporalExperiment(serializeAnalysisRecord(saved.inputs[1].data as unknown as AnalysisRecord),
    saved.inputs[2].data as unknown as RootedTemporalMetadata, saved.parameters as Partial<TemporalOptions>, signal);
  if (experiment.record.cacheKey !== saved.cacheKey || experiment.record.resultId !== saved.resultId) {
    throw new Error('Recomputed alignment/root/temporal experiment differs from saved evidence.');
  }
  return experiment;
}

export const ROOTED_DATING_METHOD = { id: 'rooted-nj-strict-clock-dating', version: '1.0.0', implementation: 'typescript' } as const;
/** Keep the diagnostic record distinct from the conditional clock record. */
export interface RootedDatingExperiment extends RootedTemporalExperiment {
  dating: DatedTreeResult;
  datingRecord: AnalysisRecord;
}

/**
 * Date a verified alignment-backed experiment. The original phylogram, not a
 * previously time-scaled tree, supplies the branch observations. Diagnostic
 * exclusions remain diagnostic-only; the clock solver retains every tree tip.
 */
export async function createRootedDatingExperiment(content: string, supplied: Partial<DatingOptions> = {},
  signal?: AbortSignal, progress: (phase: string) => void = () => {}): Promise<RootedDatingExperiment> {
  active(signal);
  const options = resolveDatingOptions(supplied); // Snapshot before parent replay yields.
  const report = (phase: string) => { active(signal); progress(phase); active(signal); };
  report('Replaying aligned DNA, the explicit root and temporal diagnostics');
  const parent = await replayRootedTemporalExperiment(content.replace(/^\uFEFF/, ''), signal);
  report('Fitting the original branch observations under strict-clock constraints');
  const dating = fitDatedTree(parent.dataset, options, report);
  active(signal);
  const fitRecord = await createDatedTreeRecord(parent.dataset, dating);
  report('Binding the complete alignment-to-dating experiment');
  const limitations = [
    'Replay recomputes the alignment, root hypothesis, temporal diagnostics and conditional strict-clock fit. It does not independently verify the source data or validate the clock.',
    'Temporal exclusions and randomization settings are retained as diagnostic evidence, not as clock-fit pruning instructions or a pass/fail clock-validation gate.',
    'Branch-length, topology and root uncertainty are not propagated into date confidence intervals. The original sequence-distance and date-provenance limitations still apply.',
  ];
  const datingRecord = await createAnalysisRecord({ method: ROOTED_DATING_METHOD,
    inputs: [...fitRecord.inputs.map(({ sha256: _sha, ...input }) => input),
      { id: 'temporalExperiment', accession: null, source: parent.dataset.source.kind,
        description: 'Verified temporal experiment with original aligned DNA, rooting decision, collection metadata and diagnostic settings',
        data: analysisJson(parent.record) }],
    parameters: analysisJson(options) as AnalysisRecord['parameters'], seed: null,
    references: [...parent.record.references, ...fitRecord.references],
    fields: { ...fitRecord.fields, lineage: { kind: 'sequence-score', label: 'Recomputed alignment-to-dating identities', units: 'records',
      value: { temporalResultId: parent.record.resultId, rootedResultId: parent.rootedResultId,
        unrootedResultId: parent.unrootedResultId, fitResultId: fitRecord.resultId },
      coverage: { available: dating.exactTips + dating.intervalTips, total: parent.result.tips.length, unit: 'records' },
      limitations } } });
  active(signal);
  return { ...parent, dating, datingRecord };
}

/** A hash-valid cached tree, fit or solver certificate cannot bypass full replay. */
export async function replayRootedDatingExperiment(content: string, signal?: AbortSignal,
  progress: (phase: string) => void = () => {}): Promise<RootedDatingExperiment> {
  active(signal);
  const saved = await parseAnalysisRecord(content.replace(/^\uFEFF/, ''),
    { methodId: ROOTED_DATING_METHOD.id, methodVersion: ROOTED_DATING_METHOD.version });
  active(signal);
  if (saved.inputs.length !== 2 || saved.inputs.map(input => input.id).join('|') !== 'datedTree|temporalExperiment'
    || Object.keys(saved.parameters).sort().join('|') !== 'fixedRate|maxIterations|maximumRate|minimumRate|rateMode|rateSource') {
    throw new Error('Linked dating replay requires the original temporal experiment, derived phylogram and every explicit clock option.');
  }
  const experiment = await createRootedDatingExperiment(
    serializeAnalysisRecord(saved.inputs[1].data as unknown as AnalysisRecord), saved.parameters as Partial<DatingOptions>, signal, progress);
  if (experiment.datingRecord.cacheKey !== saved.cacheKey || experiment.datingRecord.resultId !== saved.resultId) {
    throw new Error('Recomputed alignment/root/temporal/dating experiment differs from saved evidence.');
  }
  return experiment;
}
