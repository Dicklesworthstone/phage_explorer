#!/usr/bin/env bun
/** Headless replay of browser research tapes, with interruptible private computation. */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { COMMAND_LIMITS, parseCommandTape } from '../packages/core/src/command-session';
import { parseAnalysisRecord } from '../packages/core/src/analysis-result';
import type { TerminalResearchRequest, TerminalResearchResult,
  TerminalResearchMessage } from '../packages/tui/src/research-replay.worker';
import type { ReplayProgress } from '../packages/tui/src/research-replay';

// Build-time path only; never supplied by an input file or environment variable.
declare const PHAGE_RESEARCH_WORKER: string | undefined;

export const RESEARCH_WORKFLOW_HELP = `Replay recorded research locally, without a database or browser

bun run workflow inspect --input workflow.json [--timeout-ms 300000]
bun run workflow replay --input workflow.json [--repetitions 1] [--output analysis.json]
  [--timeout-ms 300000] [--progress]

inspect reparses embedded inputs and reports action support; no analyses run.
replay recomputes every supported command and checks its recorded output identity.
Supported: saved navigation, single-genome illustrative codon analysis, and real
pangenome/CDS experiments and exact-pairs repeats. Legacy browser-bound repeats and unknown actions are
rejected before any command executes. Navigation is headless, not a TUI rendering.

The JSON report goes to stdout only on success. --output exclusively creates the
last verified analysis (not the command tape or report), preserving its real step
identity even when later navigation occurs. Existing files/symlinks are never
replaced. No analysis output is written if computation/verification fails.
A failed or interrupted final disk write may leave a partial NEW file.

Inputs are regular UTF-8 files of at most 10 MiB, with 128 commands, 10 repetitions
and 256 executions maximum. Timeout is 1–3600000 ms (default 300000), including
input reading and final output handling. --progress emits metadata-only JSON lines
to stderr. Exit codes: 0 success, 1 failure, 124 timeout, 130 SIGINT, 143 SIGTERM.
Exported analysis JSON contains private sequences. No network or shell commands.
`;
export type WorkflowCommand = { type: 'help' } |
  { type: 'inspect'; input: string; timeoutMs: number } |
  { type: 'replay'; input: string; repetitions: number; output?: string; timeoutMs: number; progress: boolean };
export function parseWorkflowCommand(args: readonly string[]): WorkflowCommand {
  if (args.length === 1 && ['help', '--help', '-h'].includes(args[0])) return { type: 'help' };
  const [type, ...rest] = args;
  if (type !== 'inspect' && type !== 'replay') throw new Error('Choose inspect or replay; see --help.');
  const allowed = type === 'inspect' ? ['--input', '--timeout-ms'] : ['--input', '--timeout-ms', '--output', '--repetitions'];
  const values = new Map<string, string>(); let progress = false;
  for (let i = 0; i < rest.length;) {
    const key = rest[i++];
    if (key === '--progress' && type === 'replay') {
      if (progress) throw new Error('Repeated --progress flag.'); progress = true; continue;
    }
    if (!allowed.includes(key) || values.has(key)) throw new Error(`Unsupported or repeated option: ${key}`);
    const value = rest[i++];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--') || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error(`Provide a value for ${key}.`);
    values.set(key, value);
  }
  const input = values.get('--input'); if (!input) throw new Error('Missing --input.');
  const integer = (key: string, fallback: number, maximum: number) => {
    const value = values.get(key); if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) throw new Error(`${key} must be an integer from 1 to ${maximum}.`);
    return Number(value);
  };
  const timeoutMs = integer('--timeout-ms', 300000, 3600000);
  if (type === 'inspect') return { type, input, timeoutMs };
  return { type, input, timeoutMs, progress, repetitions: integer('--repetitions', 1, COMMAND_LIMITS.repetitions),
    ...(values.has('--output') ? { output: values.get('--output')! } : {}) };
}
function abort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Research workflow cancelled.', 'AbortError');
}
export type TerminalWorker = Pick<Worker, 'on' | 'once' | 'off' | 'postMessage' | 'terminate'>;
export interface WorkflowRuntime {
  signal?: AbortSignal;
  onProgress?: (progress: ReplayProgress) => void;
  createWorker?: () => TerminalWorker;
}

/** Each invocation owns exactly one worker; a late message cannot settle it twice.
 * Worker exit without a result is an error, including a zero exit code.
 */
export function runTerminalResearchWorker(request: TerminalResearchRequest, signal: AbortSignal,
  onProgress: (progress: ReplayProgress) => void = () => {},
  createWorker: () => TerminalWorker = () => new Worker(new URL(
    typeof PHAGE_RESEARCH_WORKER === 'string' ? PHAGE_RESEARCH_WORKER : '../packages/tui/src/research-replay.worker.ts', import.meta.url))): Promise<TerminalResearchResult> {
  return new Promise((resolve, reject) => {
    abort(signal);
    const submitted = structuredClone(request), tape = parseCommandTape(submitted.content);
    const total = submitted.type === 'replay' ? tape.commands.length * submitted.repetitions : 0;
    const tapeSha256 = createHash('sha256').update(submitted.content, 'utf8').digest('hex');
    const worker = createWorker();
    let completed = 0;
    let done = false;
    const finish = (result?: TerminalResearchResult, cause?: unknown) => {
      if (done) return; done = true;
      signal.removeEventListener('abort', cancelled);
      worker.off('message', message); worker.off('messageerror', messageError);
      // Keep error/exit handlers until actual exit, avoiding unhandled late errors.
      try { void worker.terminate().catch(() => {}); } catch { /* Settlement must not depend on teardown. */ }
      if (cause !== undefined) reject(cause); else resolve(result!);
    };
    const cancelled = () => {
      try { abort(signal); } catch (cause) { finish(undefined, cause); }
    };
    const error = (cause: Error) => finish(undefined, cause);
    const messageError = () => finish(undefined, new Error('Terminal research response could not be decoded.'));
    const exit = (code: number) => {
      finish(undefined, new Error(`Terminal research worker exited (${code}) before returning a result.`));
      worker.off('error', error);
    };
    const message = (value: TerminalResearchMessage) => {
      if (done) return;
      try {
        abort(signal);
        if (value?.type === 'progress' && submitted.type === 'replay') {
          const p = value.progress;
          if (!p || !['inputs', 'commands'].includes(p.phase) || !Number.isSafeInteger(p.completed) || !Number.isSafeInteger(p.total)
            || p.total !== total || p.total > COMMAND_LIMITS.executions || p.completed < completed || p.completed > completed + 1 || p.completed > p.total
            || !(p.actionId === null || typeof p.actionId === 'string')) throw new Error('Invalid terminal replay progress.');
          completed = p.completed;
          onProgress({ phase: p.phase, completed, total, actionId: p.actionId }); abort(signal); return;
        }
        if (value?.type === 'error' && typeof value.message === 'string') { finish(undefined, new Error(value.message)); return; }
        if (value?.type === 'inspection' && submitted.type === 'inspect' && value.inspection?.format === 'phage-explorer-workflow-inspection'
          && value.inspection.tapeSha256 === tapeSha256 && value.inspection.name === tape.name) finish(value);
        else if (value?.type === 'replayed' && submitted.type === 'replay' && value.report?.format === 'phage-explorer-workflow-replay'
          && value.report.tapeSha256 === tapeSha256 && value.report.name === tape.name && value.report.version === 1
          && value.report.verified === true && value.report.headless === true && value.report.repetitions === submitted.repetitions
          && value.report.completed === total && completed === total && total > 0 && total <= COMMAND_LIMITS.executions
          && Array.isArray(value.report.steps) && value.report.steps.length === total
          && value.report.steps.every((step, i) => step.execution === i + 1 && step.step === i % tape.commands.length + 1
            && step.iteration === Math.floor(i / tape.commands.length) + 1 && step.actionId === tape.commands[i % tape.commands.length].actionId)
          && (submitted.exportAnalysis ? typeof value.analysisJson === 'string' : value.analysisJson === null)) finish(value);
        else throw new Error('Unexpected terminal research response.');
      } catch (cause) { finish(undefined, cause); }
    };
    worker.on('message', message); worker.on('messageerror', messageError); worker.on('error', error); worker.once('exit', exit);
    signal.addEventListener('abort', cancelled, { once: true });
    try { abort(signal); worker.postMessage(submitted); } catch (cause) { finish(undefined, cause); }
  });
}
async function readInput(path: string, signal: AbortSignal): Promise<string> {
  abort(signal);
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    abort(signal);
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Workflow input must be a regular file.');
    if (stat.size > COMMAND_LIMITS.bytes) throw new Error('Workflow input exceeds 10 MiB.');
    const bytes = Buffer.alloc(COMMAND_LIMITS.bytes + 1); let offset = 0;
    while (offset < bytes.length) {
      abort(signal);
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break; offset += bytesRead;
    }
    if (offset > COMMAND_LIMITS.bytes) throw new Error('Workflow input exceeds 10 MiB.');
    abort(signal); return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { await file.close(); }
}
export async function executeWorkflowCommand(command: Exclude<WorkflowCommand, { type: 'help' }>, runtime: WorkflowRuntime = {}): Promise<object> {
  const controller = new AbortController();
  const cancel = () => controller.abort(runtime.signal?.reason ?? new DOMException('Research workflow cancelled.', 'AbortError'));
  runtime.signal?.addEventListener('abort', cancel, { once: true });
  if (runtime.signal?.aborted) cancel();
  const timer = setTimeout(() => controller.abort(new DOMException('Research workflow timed out.', 'TimeoutError')), command.timeoutMs);
  const signal = controller.signal;
  try {
    const content = await readInput(command.input, signal);
    const request: TerminalResearchRequest = command.type === 'inspect' ? { type: 'inspect', content }
      : { type: 'replay', content, repetitions: command.repetitions, exportAnalysis: command.output !== undefined };
    const result = await runTerminalResearchWorker(request, signal, runtime.onProgress, runtime.createWorker);
    abort(signal);
    if (result.type === 'inspection') return result.inspection;
    if (command.type === 'replay' && command.output !== undefined) {
      if (result.analysisJson === null) throw new Error('No verified analysis was returned.');
      const record = await parseAnalysisRecord(result.analysisJson);
      const index = result.report.lastAnalysisExecution;
      const identity = index === null ? null : result.report.steps[index - 1]?.analysis;
      if (!identity || record.cacheKey !== identity.cacheKey || record.resultId !== identity.resultId) throw new Error('Analysis output differs from the verified execution.');
      abort(signal);
      const file = await open(command.output, 'wx', 0o600);
      try { abort(signal); await file.writeFile(result.analysisJson, 'utf8'); await file.sync(); }
      finally { await file.close(); }
      abort(signal);
    }
    return result.report;
  } finally {
    clearTimeout(timer); runtime.signal?.removeEventListener('abort', cancel);
  }
}
export async function researchWorkflowMain(args: readonly string[], output: (text: string) => void,
  error: (text: string) => void, runtime: WorkflowRuntime = {}, invocation = 'bun run workflow'): Promise<number> {
  try {
    const command = parseWorkflowCommand(args);
    if (command.type === 'help') output(RESEARCH_WORKFLOW_HELP.replaceAll('bun run workflow', invocation));
    else {
      const report = await executeWorkflowCommand(command, { ...runtime, onProgress: progress => {
        runtime.onProgress?.(progress);
        if (command.type === 'replay' && command.progress) error(JSON.stringify({ type: 'progress', ...progress }) + '\n');
      } });
      output(JSON.stringify(report, null, 2) + '\n');
    }
    return 0;
  } catch (cause) {
    error((cause instanceof Error ? cause.message : 'Research workflow failed.').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').slice(0, 2000) + '\n');
    return cause instanceof Error && cause.name === 'TimeoutError' ? 124 : cause instanceof Error && cause.name === 'AbortError' ? 130 : 1;
  }
}
export async function runResearchWorkflowCli(args = process.argv.slice(2), invocation = 'bun run workflow'): Promise<void> {
  const controller = new AbortController(); let interrupted = 0;
  const sigint = () => { interrupted = 130; controller.abort(new DOMException('Research workflow interrupted.', 'AbortError')); };
  const sigterm = () => { interrupted = 143; controller.abort(new DOMException('Research workflow terminated.', 'AbortError')); };
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
  try {
    const code = await researchWorkflowMain(args, text => { process.stdout.write(text); }, text => { process.stderr.write(text); }, { signal: controller.signal }, invocation);
    process.exitCode = interrupted || code;
  } finally { process.off('SIGINT', sigint); process.off('SIGTERM', sigterm); }
}
if (import.meta.main) void runResearchWorkflowCli();
