/** Headless host for the existing browser command adapters. No second executor,
 * catalog, numerical implementation, implicit file access or UI renderer.
 * Loading is declarative; replay explicitly uses only the tape's embedded inputs.
 */
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { ResearchWorkflow, type ResearchView } from '../../web/src/keyboard/ResearchWorkflow';
import { executePangenomeRequest } from '../../web/src/workers/PangenomeSession';
import { COMMAND_LIMITS, parseCommandTape, parseCommandPlan, serializeCommandTape, type CommandTape } from '../../core/src/command-session';
import { importLocalGenomes, type LocalGenome, type GenomeImportResult } from '../../core/src/genome-import';
import { createExactRepeatRecord } from '../../core/src/analysis/exact-repeat-pairs';
import { createGCSkewRecord } from '../../core/src/analysis/gc-skew';
import type { AnalysisRecord } from '../../core/src/analysis-result';
import { WorkflowResultCollector, parseWorkflowResults } from '../../core/src/workflow-results';

const IDS = { view: ActionIds.NavGoto, repeats: ActionIds.OverlayRepeats,
  codons: ActionIds.OverlayCodonAdaptation, pangenome: ActionIds.OverlayPangenomeGraph, gcSkew: ActionIds.OverlayGCSkew,
  dotPlot: ActionIds.OverlayDotPlot, digest: ActionIds.OverlayGel };
const SUPPORTED: readonly string[] = [IDS.view, IDS.codons, IDS.pangenome, IDS.gcSkew, IDS.dotPlot, IDS.digest];
const REPEAT_LIMIT = 'Legacy repeat recordings bind a browser transport and kernel implementation. Replay this tape in the browser; terminal execution will not relabel a different backend as verified.';
export interface ReplayProgress { phase: 'inputs' | 'commands'; completed: number; total: number; actionId: string | null }
export interface ReplayStep {
  execution: number; iteration: number; step: number; actionId: string;
  analysis: { method: AnalysisRecord['method']; cacheKey: string; resultId: string } | null;
  view: ResearchView | null;
}
export interface ResearchTapeInspection {
  format: 'phage-explorer-workflow-inspection'; version: 1; name: string; tapeSha256: string;
  canReplay: boolean; steps: Array<{ step: number; actionId: string; supported: boolean; reason: string | null }>;
  genomes: Array<{ contentId: string; accession: string; bases: number; mappedFeatures: number }>;
}
export interface ResearchReplayResult {
  report: {
    format: 'phage-explorer-workflow-replay'; version: 1; name: string; tapeSha256: string;
    verified: true; headless: true; repetitions: number; completed: number; steps: ReplayStep[];
    finalView: ResearchView | null; lastAnalysisExecution: number | null;
    interpretation: string;
  };
  /** Last verified ANALYSIS, even when later navigation clears the visible result.
   * Its actual execution index is recorded; never relabel it as the final view.
   */
  lastAnalysis: AnalysisRecord | null;
  /** Present only for explicitly requested complete-run capture. */
  allResultsJson?: string;
}
export interface ResearchReplayOptions { repetitions?: number; signal?: AbortSignal; onProgress?: (progress: ReplayProgress) => void; captureResults?: boolean }
export interface ResearchRecordingResult {
  report: {
    format: 'phage-explorer-workflow-recording'; version: 1; headless: true;
    name: string; planSha256: string; tapeSha256: string; completed: number;
    steps: ReplayStep[]; finalView: ResearchView | null; lastAnalysisExecution: number | null;
    interpretation: string;
  };
  tapeJson: string;
  allResultsJson?: string;
}

function abort(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Research replay cancelled.', 'AbortError');
}
function bundleOf(tape: CommandTape): string {
  const context = tape.context;
  if (!context || typeof context !== 'object' || Array.isArray(context) || Object.keys(context).length !== 1 || typeof context.bundle !== 'string') {
    throw new Error('Research replay requires exactly the original embedded genome bundle.');
  }
  return context.bundle;
}
async function checksum(content: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
function stepsOf(tape: CommandTape): ResearchTapeInspection['steps'] {
  return tape.commands.map((command, i) => {
    const p = command.parameters;
    const exact = command.actionId === IDS.repeats && p !== null && typeof p === 'object' && !Array.isArray(p) && p.method === 'exact-pairs';
    const supported = SUPPORTED.includes(command.actionId) || exact;
    return { step: i + 1, actionId: command.actionId, supported,
      reason: supported ? null : command.actionId === IDS.repeats ? REPEAT_LIMIT : 'No terminal adapter exists for this action.' };
  });
}
function host(bundle: string) {
  let genomes: LocalGenome[] = [], view: ResearchView | null = null;
  let parsed: Promise<GenomeImportResult> | null = null;
  const parse = async (content: string, signal: AbortSignal): Promise<GenomeImportResult> => {
    abort(signal);
    if (content !== bundle) throw new Error('The replay input bundle changed.');
    // One parse per invocation; the adapter and host receive independent copies.
    parsed ??= importLocalGenomes({ name: 'workflow-genomes.json', text: content });
    const result = await parsed; abort(signal); return structuredClone(result);
  };
  const workflow = new ResearchWorkflow(IDS, {
    genomes: () => genomes, bundle: () => bundle, parseBundle: parse, currentView: () => view,
    applyView: async (next, signal) => { abort(signal); view = structuredClone(next); },
    repeats: async () => { throw new Error(REPEAT_LIMIT); },
    dotPlot: async (genome, comparison, options, signal) => {
      abort(signal);
      // Share the numerical producer, not a browser worker's global message handler.
      const { createDotPlotExperiment, createPairwiseDotPlotExperiment } = await import('../../core/src/analysis/dot-plot');
      abort(signal);
      const input = (item: LocalGenome) => ({ sequence: item.sequence, accession: item.phage.accession, source: 'local' as const });
      const result = comparison === null ? await createDotPlotExperiment(input(genome), options)
        : await createPairwiseDotPlotExperiment(input(genome), input(comparison), options);
      abort(signal); return result.record;
    },
    digest: async (genome, options, signal) => {
      abort(signal);
      const { createRestrictionDigestRecord } = await import('../../core/src/analysis/restriction-digest');
      abort(signal);
      const record = await createRestrictionDigestRecord(genome.sequence, options, { accession: genome.phage.accession, source: 'local' });
      abort(signal); return record;
    },
    gcSkew: async (genome, options, signal) => {
      abort(signal);
      const record = await createGCSkewRecord(genome.sequence, options, { accession: genome.phage.accession, source: 'local' });
      abort(signal); return record;
    },
    exactRepeats: async (genome, options, signal) => {
      abort(signal);
      const record = await createExactRepeatRecord(genome.sequence, options, { accession: genome.phage.accession, source: 'local' });
      abort(signal); return record;
    },
    codons: async (genome, geneId, signal) => {
      abort(signal);
      // Identical selection contract to research-workflow.worker.ts; the core
      // producer is shared. This command retains its illustrative host model.
      const { analyzePhageHostCodonAdaptation, createCodonAdaptationRecord } = await import('../../core/src/analysis/codon-pair-adaptation');
      abort(signal);
      const phage = structuredClone(genome.phage);
      phage.genes = phage.genes.filter(gene => gene.type === 'CDS' && (geneId === null || gene.id === geneId));
      if (!phage.genes.length) throw new Error('No supported CDS annotations are available for this command.');
      phage.codonUsage = null;
      const analysis = analyzePhageHostCodonAdaptation(phage, { genomeSequence: genome.sequence });
      const record = await createCodonAdaptationRecord(phage, genome.sequence, analysis);
      abort(signal); return record;
    },
    referenceCodons: async (genome, referenceText, options, signal) => {
      abort(signal);
      const { createReferenceCodonExperiment, referenceGenomeFromPhage } = await import('../../core/src/analysis/codon-reference');
      abort(signal);
      const result = await createReferenceCodonExperiment(referenceGenomeFromPhage(genome.phage), genome.sequence, referenceText, options);
      abort(signal); return result.record;
    },
    pangenome: async (request, signal) => {
      abort(signal);
      const result = await executePangenomeRequest(request);
      abort(signal);
      if (!result.record) throw new Error('Pangenome computation returned no evidence.');
      return result.record;
    },
  });
  return { workflow, parse, view: () => view,
    install(result: GenomeImportResult) {
      genomes = structuredClone(result.genomes);
      view = result.view ? { ...result.view, geneId: null } : null;
    } };
}

/** Inspect bounded inputs and action support, without computing any analysis. */
export async function inspectResearchTape(content: string, signal = new AbortController().signal): Promise<ResearchTapeInspection> {
  abort(signal);
  const tape = parseCommandTape(content), bundle = bundleOf(tape), steps = stepsOf(tape);
  // Known adapters still validate the whole tape's parameter shapes. Unknown
  // actions are reported, not interpreted or executed during inspection.
  if (steps.every(step => step.supported || step.actionId === IDS.repeats)) host(bundle).workflow.load(content);
  const parsed = await importLocalGenomes({ name: 'workflow-genomes.json', text: bundle });
  abort(signal);
  const tapeSha256 = await checksum(content); abort(signal);
  return { format: 'phage-explorer-workflow-inspection', version: 1, name: tape.name, tapeSha256,
    canReplay: steps.length > 0 && steps.every(step => step.supported), steps,
    genomes: parsed.genomes.map(genome => ({ contentId: genome.phage.localGenome!.contentId,
      accession: genome.phage.accession, bases: genome.sequence.length, mappedFeatures: genome.phage.genes.length })) };
}

/** Author an ordinary portable tape through the SAME adapters used by replay.
 * The isolated host never publishes a partial tape on error or cancellation.
 * This records fresh results; it does not claim independent replay verification.
 */
export async function recordResearchPlan(content: string,
  options: Omit<ResearchReplayOptions, 'repetitions'> = {}): Promise<ResearchRecordingResult> {
  const signal = options.signal ?? new AbortController().signal;
  abort(signal);
  const plan = parseCommandPlan(content);
  const validationTape: CommandTape = { ...plan, format: 'phage-explorer-commands',
    commands: plan.commands.map(command => ({ ...command, expected: null })) };
  const bundle = bundleOf(validationTape);
  const unsupported = stepsOf(validationTape).find(step => !step.supported);
  if (unsupported) throw new Error(`Step ${unsupported.step} (${unsupported.actionId}): ${unsupported.reason}`);
  if (!plan.commands.length) throw new Error('There are no planned commands to record.');
  const environment = host(bundle), workflow = environment.workflow;
  // Validate every action's full parameters BEFORE input parsing or computation.
  workflow.load(serializeCommandTape(validationTape));
  const total = plan.commands.length, steps: ReplayStep[] = [];
  const collector = options.captureResults ? new WorkflowResultCollector() : null;
  let lastAnalysisExecution: number | null = null;
  const progress = (phase: ReplayProgress['phase'], actionId: string | null) => {
    options.onProgress?.({ phase, completed: steps.length, total, actionId }); abort(signal);
  };
  const cancel = () => workflow.commands.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    abort(signal); progress('inputs', null);
    environment.install(await environment.parse(bundle, signal));
    const planSha256 = await checksum(content); abort(signal);
    workflow.start(plan.name);
    progress('commands', null);
    for (const command of plan.commands) {
      abort(signal);
      try { await workflow.commands.dispatch(command.actionId, command.parameters); }
      catch (cause) {
        if (signal.aborted) throw new DOMException('Research recording cancelled.', 'AbortError');
        throw new Error(`Step ${steps.length + 1} (${command.actionId}): ${cause instanceof Error ? cause.message : String(cause)}`);
      }
      abort(signal);
      const result = workflow.getSnapshot().result, execution = steps.length + 1;
      if (result) { lastAnalysisExecution = execution; collector?.add(result); }
      steps.push({ execution, iteration: 1, step: execution, actionId: command.actionId,
        view: structuredClone(environment.view()),
        analysis: result ? { method: { ...result.method }, cacheKey: result.cacheKey, resultId: result.resultId } : null });
      progress('commands', command.actionId);
    }
    workflow.commands.stop();
    const tapeJson = workflow.commands.export(), tapeSha256 = await checksum(tapeJson);
    const allResultsJson = collector ? await collector.finish(tapeJson, 1, signal) : undefined;
    abort(signal);
    return { tapeJson, ...(allResultsJson === undefined ? {} : { allResultsJson }), report: { format: 'phage-explorer-workflow-recording', version: 1, headless: true,
      name: plan.name, planSha256, tapeSha256, completed: steps.length, steps,
      finalView: structuredClone(environment.view()), lastAnalysisExecution,
      interpretation: 'Fresh computation recorded through canonical adapters. This is a new baseline, not replay verification or biological validation. Replay the tape to verify its recorded outputs.' } };
  } finally {
    signal.removeEventListener('abort', cancel); workflow.commands.cancel();
  }
}

/** Compute every recorded output and verify it BEFORE the existing adapter applies
 * that step. A thrown error returns no report or publishable final analysis.
 * For interruptible CPU work, call this inside the terminal replay worker.
 */
export async function replayResearchTape(content: string, options: ResearchReplayOptions = {}): Promise<ResearchReplayResult> {
  const signal = options.signal ?? new AbortController().signal;
  abort(signal);
  const tape = parseCommandTape(content), bundle = bundleOf(tape), repetitions = options.repetitions ?? 1;
  const unsupported = stepsOf(tape).find(step => !step.supported);
  if (unsupported) throw new Error(`Step ${unsupported.step} (${unsupported.actionId}): ${unsupported.reason}`);
  if (!tape.commands.length) throw new Error('There are no recorded commands to replay.');
  if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > COMMAND_LIMITS.repetitions || tape.commands.length * repetitions > COMMAND_LIMITS.executions) {
    throw new Error('Replay allows 1–10 repetitions and at most 256 executions.');
  }
  const environment = host(bundle), workflow = environment.workflow;
  workflow.load(content); // All command parameters checked before parsing/computation.
  const total = tape.commands.length * repetitions;
  const collector = options.captureResults ? new WorkflowResultCollector() : null;
  const progress = (phase: ReplayProgress['phase'], completed: number, actionId: string | null) => {
    options.onProgress?.({ phase, completed, total, actionId }); abort(signal);
  };
  const cancel = () => workflow.commands.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  let unsubscribe = () => {};
  try {
    progress('inputs', 0, null);
    environment.install(await environment.parse(bundle, signal));
    const tapeSha256 = await checksum(content); abort(signal);
    const steps: ReplayStep[] = [];
    let lastAnalysis: AnalysisRecord | null = null, lastAnalysisExecution: number | null = null;
    unsubscribe = workflow.commands.subscribe(() => {
      const completed = workflow.commands.getSnapshot().completed;
      if (completed <= steps.length) return;
      const index = (completed - 1) % tape.commands.length;
      const result = workflow.getSnapshot().result;
      if (result) { lastAnalysis = result; lastAnalysisExecution = completed; collector?.add(result); }
      steps.push({ execution: completed, iteration: Math.floor((completed - 1) / tape.commands.length) + 1,
        step: index + 1, actionId: tape.commands[index].actionId,
        view: structuredClone(environment.view()),
        analysis: result ? { method: { ...result.method }, cacheKey: result.cacheKey, resultId: result.resultId } : null });
      progress('commands', completed, tape.commands[index].actionId);
    });
    progress('commands', 0, null);
    await workflow.commands.replay(repetitions);
    const allResultsJson = collector ? await collector.finish(content, repetitions, signal) : undefined;
    abort(signal);
    return { report: { format: 'phage-explorer-workflow-replay', version: 1, name: tape.name, tapeSha256,
      verified: true, headless: true, repetitions, completed: steps.length, steps,
      finalView: structuredClone(environment.view()), lastAnalysisExecution,
      interpretation: 'Fresh recorded-output verification with headless view state, not a rendered TUI or biological validation. The legacy single-genome codon action remains illustrative.' },
      lastAnalysis, ...(allResultsJson === undefined ? {} : { allResultsJson }) };
  } catch (cause) {
    if (signal.aborted) throw new DOMException('Research replay cancelled.', 'AbortError');
    throw new Error(workflow.commands.getSnapshot().error ?? (cause instanceof Error ? cause.message : 'Research replay failed.'));
  } finally {
    unsubscribe(); signal.removeEventListener('abort', cancel); workflow.commands.cancel();
  }
}

/** Recompute the entire archived tape, not just its last method or stored hashes.
 * Unknown actions, changed evidence and cancellation return no partial archive.
 */
export async function replayResearchResults(content: string, options: Omit<ResearchReplayOptions, 'repetitions' | 'captureResults'> = {}) {
  const saved = await parseWorkflowResults(content, options.signal);
  const result = await replayResearchTape(saved.tapeJson, { ...options, repetitions: saved.repetitions, captureResults: true });
  const fresh = await parseWorkflowResults(result.allResultsJson!, options.signal);
  if (JSON.stringify(saved) !== JSON.stringify(fresh)) throw new Error('Recomputed workflow results differ from the saved archive.');
  return { report: result.report, archiveJson: result.allResultsJson! };
}
