/** Headless host for the existing browser command adapters. No second executor,
 * catalog, numerical implementation, implicit file access or UI renderer.
 * Loading is declarative; replay explicitly uses only the tape's embedded inputs.
 */
import { ActionIds } from '../../web/src/keyboard/actionRegistry';
import { ResearchWorkflow, type ResearchView } from '../../web/src/keyboard/ResearchWorkflow';
import { executePangenomeRequest } from '../../web/src/workers/PangenomeSession';
import { COMMAND_LIMITS, parseCommandTape, type CommandTape } from '../../core/src/command-session';
import { importLocalGenomes, type LocalGenome, type GenomeImportResult } from '../../core/src/genome-import';
import type { AnalysisRecord } from '../../core/src/analysis-result';

const IDS = { view: ActionIds.NavGoto, repeats: ActionIds.OverlayRepeats,
  codons: ActionIds.OverlayCodonAdaptation, pangenome: ActionIds.OverlayPangenomeGraph };
const SUPPORTED: readonly string[] = [IDS.view, IDS.codons, IDS.pangenome];
const REPEAT_LIMIT = 'Repeat recordings bind a browser transport and kernel implementation. Replay this tape in the browser; terminal execution will not relabel a different backend as verified.';
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
}
export interface ResearchReplayOptions { repetitions?: number; signal?: AbortSignal; onProgress?: (progress: ReplayProgress) => void }

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
  return tape.commands.map((command, i) => ({ step: i + 1, actionId: command.actionId,
    supported: SUPPORTED.includes(command.actionId),
    reason: SUPPORTED.includes(command.actionId) ? null : command.actionId === IDS.repeats ? REPEAT_LIMIT : 'No terminal adapter exists for this action.' }));
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
      if (result) { lastAnalysis = result; lastAnalysisExecution = completed; }
      steps.push({ execution: completed, iteration: Math.floor((completed - 1) / tape.commands.length) + 1,
        step: index + 1, actionId: tape.commands[index].actionId,
        view: structuredClone(environment.view()),
        analysis: result ? { method: { ...result.method }, cacheKey: result.cacheKey, resultId: result.resultId } : null });
      progress('commands', completed, tape.commands[index].actionId);
    });
    progress('commands', 0, null);
    await workflow.commands.replay(repetitions);
    abort(signal);
    return { report: { format: 'phage-explorer-workflow-replay', version: 1, name: tape.name, tapeSha256,
      verified: true, headless: true, repetitions, completed: steps.length, steps,
      finalView: structuredClone(environment.view()), lastAnalysisExecution,
      interpretation: 'Fresh recorded-output verification with headless view state, not a rendered TUI or biological validation. The legacy single-genome codon action remains illustrative.' },
      lastAnalysis };
  } catch (cause) {
    if (signal.aborted) throw new DOMException('Research replay cancelled.', 'AbortError');
    throw new Error(workflow.commands.getSnapshot().error ?? (cause instanceof Error ? cause.message : 'Research replay failed.'));
  } finally {
    unsubscribe(); signal.removeEventListener('abort', cancel); workflow.commands.cancel();
  }
}
