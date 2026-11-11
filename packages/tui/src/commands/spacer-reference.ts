/** Native transport and file boundaries for the shared spacer-reference workspace. */
import type { TerminalAcrRequest, TerminalAcrResult, TerminalAcrMessage } from './acr-heuristic';
import { Worker } from 'node:worker_threads';
import { constants } from 'node:fs';
import { lstat, open, writeFile } from 'node:fs/promises';
import { parseArgs, stripVTControlCharacters } from 'node:util';
import { executeSpacerRequest, type SpacerWorker, type SpacerMessage, type SpacerWorkResult,
  type SpacerRequest } from '../../../web/src/workers/SpacerReferenceSession';
import { SPACER_LIMITS, validateSpacerGenome, type SpacerGenome, type SpacerSearchOptions } from '../../../core/src/analysis/spacer-reference';
import { serializeAnalysisRecord } from '../../../core/src/analysis-result';
import { readAbundanceStdin } from './abundance';
import type { Readable, Writable } from 'node:stream';
import { basename, resolve } from 'node:path';

// The production two-stage build embeds this worker beside its entry point.
declare const PHAGE_SPACER_WORKER: string | undefined;

/** Adapt the existing browser/session protocol; search and replay stay in the shared engine. */
export function createTerminalSpacerWorker(): SpacerWorker {
  const worker = new Worker(new URL(typeof PHAGE_SPACER_WORKER === 'string'
    ? PHAGE_SPACER_WORKER : '../workers/spacer-reference-worker.ts', import.meta.url));
  let stopped = false, returned = false;
  const adapter: SpacerWorker = {
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage: request => worker.postMessage(request),
    terminate: () => {
      if (stopped) return;
      stopped = true; clearTimeout(timeout);
      // Keep the error listener until termination so a late error is harmless.
      void worker.terminate().catch(() => {});
    },
  };
  const fail = (message: string) => {
    if (!stopped) adapter.onmessage?.({ data: { kind: 'error', message } } as MessageEvent<SpacerMessage>);
  };
  const timeout = setTimeout(() => fail('Spacer computation exceeded five minutes. Narrow the reference scope and retry.'), 300000);
  worker.on('message', (data: SpacerMessage) => {
    if (stopped) return;
    if (data?.kind === 'result' || data?.kind === 'error') returned = true;
    adapter.onmessage?.({ data } as MessageEvent<SpacerMessage>);
  });
  worker.on('error', cause => fail(cause instanceof Error ? cause.message : 'Spacer worker failed.'));
  worker.on('messageerror', () => fail('Spacer worker response could not be decoded.'));
  worker.on('exit', code => {
    clearTimeout(timeout);
    if (!returned) fail(`Spacer worker exited (${code}) without a result.`);
  });
  return adapter;
}

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Spacer operation cancelled.', 'AbortError');
}
function path(value: string): void {
  if (!value.trim() || value.length > 8192 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error('Enter a regular file path without control characters (at most 8192 characters).');
  }
}

/** Bounded regular UTF-8 files only; nonblocking open also rejects FIFOs promptly. */
export async function readTerminalSpacerFile(filename: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
  path(filename); check(signal);
  const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    check(signal);
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Spacer inputs must be regular UTF-8 files.');
    if (stat.size > maxBytes) throw new Error(`Spacer input exceeds the ${maxBytes}-byte limit.`);
    const chunks: Buffer[] = [];
    let bytes = 0;
    for (;;) {
      check(signal);
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - bytes));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      check(signal);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > maxBytes) throw new Error(`Spacer input exceeds the ${maxBytes}-byte limit.`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
  } finally { await file.close(); }
}

/** Export a captured accepted result. No overwrite, symlink following or implicit directory creation. */
export async function writeTerminalSpacerFile(filename: string, content: string): Promise<void> {
  path(filename);
  const file = await open(filename, 'wx', 0o600);
  try { await file.writeFile(content, 'utf8'); await file.sync(); }
  finally { await file.close(); }
}

/** Labels are sanitized only for display; original source text stays in checksummed exports. */
export const spacerTerminalLabel = (value: string): string => stripVTControlCharacters(value)
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '�');

/** Complete hit coordinates, oriented mismatches and rule outcomes. JSON remains the replay format. */
export function terminalSpacerHitsTsv(value: SpacerWorkResult): string {
  if (!value.record || !value.result || !value.genome) throw new Error('Run a spacer comparison before exporting hits.');
  const text = (input: unknown) => JSON.stringify(input);
  const metadata = { format: 'phage-explorer-spacer-hits', version: 1, method: value.record.method,
    resultId: value.record.resultId, cacheKey: value.record.cacheKey, genome: value.genome.name,
    accession: value.genome.accession, topology: value.genome.topology, source: value.library.source,
    parameters: value.result.options, status: value.result.status, selectedRecords: value.result.selectedRecords,
    searchedRecords: value.result.searchedRecords, complete: value.result.complete,
    coordinates: '0-based half-open forward-genome intervals; wrapped hits have traversal-ordered segments; mismatch offsets are guide-equivalent',
    limitations: value.result.warnings };
  const lines = ['# ' + text(metadata),
    'spacer_id\thost_id\tstart\tend\tstrand\twraps_origin\tsegments\tprotospacer\tidentity\tmismatch_offsets\tpam_status\tpam_sequence\tpam_segments\tpam_reason\tseed_status\tseed_mismatches'];
  for (const hit of value.result.hits) lines.push([
    text(hit.spacerId), text(hit.hostId), hit.start, hit.end, hit.strand, hit.wrapsOrigin,
    text(hit.segments), hit.protospacer, hit.identity, text(hit.mismatchPositions), hit.pam.status,
    hit.pam.sequence ?? '', text(hit.pam.segments), text(hit.pam.reason), hit.seed.status, hit.seed.mismatches ?? '',
  ].join('\t'));
  return lines.join('\n') + '\n';
}


/** Explicit optional Acr shortlist on the captured current genome, never a spacer result. */
export async function runTerminalAcrHeuristic(request: TerminalAcrRequest, signal: AbortSignal,
  progress: (phase: string) => void = () => {}): Promise<TerminalAcrResult> {
  check(signal);
  const captured = structuredClone(request);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(typeof PHAGE_SPACER_WORKER === 'string'
      ? PHAGE_SPACER_WORKER : '../workers/spacer-reference-worker.ts', import.meta.url));
    let settled = false;
    const finish = (value?: TerminalAcrResult, cause?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timeout); signal.removeEventListener('abort', cancel);
      void worker.terminate().catch(() => {});
      if (cause) reject(cause); else resolve(value!);
    };
    const cancel = () => finish(undefined, new DOMException('Acr heuristic cancelled.', 'AbortError'));
    const timeout = setTimeout(() => finish(undefined, new Error('Acr heuristic exceeded five minutes.')), 300000);
    signal.addEventListener('abort', cancel, { once: true });
    worker.on('message', (message: TerminalAcrMessage) => {
      if (settled) return;
      if (message?.kind === 'progress' && typeof message.phase === 'string') progress(message.phase);
      else if (message?.kind === 'acr-result' && Array.isArray(message.value?.candidates)) finish(message.value);
      else finish(undefined, new Error(message?.kind === 'error' ? message.message : 'Unexpected Acr worker response.'));
    });
    worker.on('error', cause => finish(undefined, cause instanceof Error ? cause : new Error('Acr worker failed.')));
    worker.on('messageerror', () => finish(undefined, new Error('Acr worker response could not be decoded.')));
    worker.on('exit', code => { if (!settled) finish(undefined, new Error(`Acr worker exited (${code}) without a result.`)); });
    try { if (signal.aborted) cancel(); else worker.postMessage(captured); }
    catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
  });
}


// =============================================================================
// Headless spacer evidence CLI
// =============================================================================

const SPACER_RECORD_LIMIT = 10 * 1024 * 1024;
const SPACER_GENOME_FILE_LIMIT = SPACER_LIMITS.genomeBases + 1024 * 1024;

export const SPACER_COMMAND_HELP = `Sourced CRISPR spacer DNA evidence (local files only; no catalog/network required)

  phage-explorer spacer inspect LIBRARY_JSON
  phage-explorer spacer analyze GENOME --library LIBRARY_JSON [--host HOST_ID] [--mismatches 0..5] [--topology unknown|linear|circular]
  phage-explorer spacer replay SAVED_ANALYSIS --genome GENOME [--topology unknown|linear|circular]

Common options:
  --format json|tsv    analyze/replay output format (default json)
  --output NEW_FILE    write a new file; existing files are never replaced
  -                    use stdin for at most one input

GENOME may be a canonical SpacerGenome JSON object or a single-record DNA FASTA.
FASTA is local evidence; its complete header is retained as the genome name and
its accession is left unknown. Topology defaults to unknown and must be stated
explicitly for circular-origin searches. Canonical genome JSON retains its embedded
identity/topology and cannot be relabeled by --topology.

analyze searches the exact supplied library with the same bounded complete Hamming
matcher as the browser/TUI overlay. replay requires the genome again and rejects
any sequence, identity or topology mismatch with the saved experiment. TSV exports
every accepted hit and its guide-oriented mismatch/PAM/seed evidence.

Sequence similarity and supplied PAM/seed rules do not establish interference,
immunity, susceptibility, host range or anti-CRISPR activity.
`;

export type SpacerCommandOperation = 'inspect' | 'analyze' | 'replay';
export interface SpacerCommand {
  operation: SpacerCommandOperation;
  input: string;
  library?: string;
  genome?: string;
  hostId?: string;
  maxMismatches: number;
  topology: SpacerGenome['topology'];
  topologyExplicit: boolean;
  format: 'json' | 'tsv';
  output?: string;
}
export interface SpacerCommandIO {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  signal?: AbortSignal;
  execute?: typeof runSpacerHeadlessJob;
}
export interface SpacerHeadlessJob {
  operation: SpacerCommandOperation;
  input: { name: string; text: string };
  library?: { name: string; text: string };
  genome?: { name: string; text: string };
  hostId?: string;
  maxMismatches: number;
  topology: SpacerGenome['topology'];
  topologyExplicit: boolean;
}
export interface SpacerHeadlessResult {
  content: string;
  tsv: string | null;
  identity: string | null;
  verified: boolean;
}

function parseHeadlessGenome(content: string, name: string, topology: SpacerGenome['topology'], topologyExplicit: boolean): SpacerGenome {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > SPACER_GENOME_FILE_LIMIT) {
    throw new Error('Genome input exceeds the supported file limit.');
  }
  const text = content.replace(/^\uFEFF/, '').trim();
  if (text.startsWith('{')) {
    if (topologyExplicit) throw new Error('Canonical genome JSON retains its embedded topology; --topology applies only to FASTA.');
    return validateSpacerGenome(JSON.parse(text));
  }
  const lines = text.split(/\r?\n/);
  if (!lines[0]?.startsWith('>')) throw new Error('Genome input must be canonical JSON or a single-record DNA FASTA.');
  const header = lines[0].slice(1).trim();
  if (!header || /[\u0000-\u001f\u007f-\u009f]/.test(header) || header.length > 2000) {
    throw new Error('FASTA genome header must be nonempty plain text.');
  }
  if (lines.slice(1).some(line => line.startsWith('>'))) throw new Error('Spacer analysis accepts exactly one FASTA genome record.');
  const sequence = lines.slice(1).map(line => line.trim()).join('').toUpperCase();
  return validateSpacerGenome({ name: header || name, accession: null, sequence, topology, source: 'local' });
}

function spacerOutput(value: SpacerWorkResult): SpacerHeadlessResult {
  if (!value.record || !value.result || !value.genome) throw new Error('Expected a completed spacer comparison.');
  return { content: serializeAnalysisRecord(value.record), tsv: terminalSpacerHitsTsv(value),
    identity: value.record.resultId, verified: value.verified };
}

export async function executeSpacerHeadlessJob(job: SpacerHeadlessJob,
  progress: (phase: string) => void = () => {}): Promise<SpacerHeadlessResult> {
  if (!job || !['inspect','analyze','replay'].includes(job.operation) || !job.input || typeof job.input.text !== 'string') {
    throw new Error('Unsupported spacer command job.');
  }
  if (job.operation === 'inspect') {
    if (job.library || job.genome) throw new Error('Spacer library inspection takes exactly one library input.');
    const value = await executeSpacerRequest({ kind: 'library', content: job.input.text }, progress);
    return { content: JSON.stringify(value.library, null, 2), tsv: null, identity: null, verified: false };
  }
  if (job.operation === 'analyze') {
    if (!job.library || job.genome) throw new Error('Spacer analysis requires exactly one --library input beside the genome.');
    const loaded = await executeSpacerRequest({ kind: 'library', content: job.library.text }, progress);
    const genome = parseHeadlessGenome(job.input.text, job.input.name, job.topology, job.topologyExplicit);
    const options: Partial<SpacerSearchOptions> = { hostId: job.hostId ?? null, maxMismatches: job.maxMismatches };
    return spacerOutput(await executeSpacerRequest({ kind: 'analyze', genome, library: loaded.library, options }, progress));
  }
  if (!job.genome || job.library) throw new Error('Spacer replay requires exactly one --genome input and no library override.');
  const genome = parseHeadlessGenome(job.genome.text, job.genome.name, job.topology, job.topologyExplicit);
  return spacerOutput(await executeSpacerRequest({ kind: 'replay', content: job.input.text, genome }, progress));
}

export function runSpacerHeadlessJob(job: SpacerHeadlessJob, signal?: AbortSignal,
  progress: (phase: string) => void = () => {}): Promise<SpacerHeadlessResult> {
  if (signal?.aborted) return Promise.reject(new DOMException('Spacer operation cancelled.', 'AbortError'));
  const request = async (): Promise<SpacerRequest> => {
    if (job.operation === 'inspect') return { kind: 'library', content: job.input.text };
    if (job.operation === 'analyze') {
      if (!job.library) throw new Error('Spacer analysis requires --library.');
      const library = (await executeSpacerRequest({ kind: 'library', content: job.library.text }, progress)).library;
      const genome = parseHeadlessGenome(job.input.text, job.input.name, job.topology, job.topologyExplicit);
      return { kind: 'analyze', genome, library, options: { hostId: job.hostId ?? null, maxMismatches: job.maxMismatches } };
    }
    if (!job.genome) throw new Error('Spacer replay requires --genome.');
    return { kind: 'replay', content: job.input.text,
      genome: parseHeadlessGenome(job.genome.text, job.genome.name, job.topology, job.topologyExplicit) };
  };
  return request().then(requestValue => new Promise<SpacerHeadlessResult>((resolveResult, reject) => {
    const worker = createTerminalSpacerWorker();
    let settled = false;
    const finish = (result?: SpacerHeadlessResult, cause?: Error) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', cancel); worker.terminate();
      if (cause) reject(cause); else resolveResult(result!);
    };
    const cancel = () => finish(undefined, new DOMException('Spacer operation cancelled.', 'AbortError'));
    signal?.addEventListener('abort', cancel, { once: true });
    worker.onmessage = event => {
      if (settled || signal?.aborted) return;
      const message = event.data;
      if (message?.kind === 'progress' && typeof message.phase === 'string') {
        try { progress(message.phase); } catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
      } else if (message?.kind === 'result') {
        if (job.operation === 'inspect') finish({ content: JSON.stringify(message.value.library, null, 2),
          tsv: null, identity: null, verified: false });
        else {
          try { finish(spacerOutput(message.value)); } catch (cause) { finish(undefined, cause instanceof Error ? cause : new Error(String(cause))); }
        }
      } else finish(undefined, new Error(message?.kind === 'error' ? message.message : 'Unexpected spacer worker response.'));
    };
    worker.onerror = () => finish(undefined, new Error('Spacer worker failed.'));
    worker.onmessageerror = () => finish(undefined, new Error('Spacer worker response could not be decoded.'));
    if (signal?.aborted) cancel(); else worker.postMessage(requestValue);
  }));
}

export function parseSpacerCommand(args: string[]): SpacerCommand | null {
  const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: {
    library: { type: 'string' }, genome: { type: 'string' }, host: { type: 'string' },
    mismatches: { type: 'string' }, topology: { type: 'string' }, format: { type: 'string' },
    output: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help || args.length === 0) return null;
  const [operation, input] = positionals;
  if (positionals.length !== 2 || !['inspect','analyze','replay'].includes(operation)) {
    throw new Error('Expected spacer inspect|analyze|replay INPUT. See spacer --help.');
  }
  if (!input.trim() || [values.library, values.genome, values.host, values.output].some(value => value !== undefined && !value.trim())) {
    throw new Error('Spacer paths and host IDs must not be empty.');
  }
  const mismatches = values.mismatches === undefined ? 0 : Number(values.mismatches);
  if (!Number.isSafeInteger(mismatches) || mismatches < 0 || mismatches > 5) throw new Error('--mismatches must be an integer from 0 to 5.');
  const topologyExplicit = values.topology !== undefined;
  const topology = values.topology ?? 'unknown';
  if (!['unknown','linear','circular'].includes(topology)) throw new Error('--topology must be unknown, linear or circular.');
  const format = values.format ?? 'json';
  if (format !== 'json' && format !== 'tsv') throw new Error('--format must be json or tsv.');
  if (operation === 'inspect') {
    if (values.library !== undefined || values.genome !== undefined || values.host !== undefined || values.mismatches !== undefined
      || values.topology !== undefined || format !== 'json') throw new Error('spacer inspect takes one library JSON and no search settings.');
  } else if (operation === 'analyze') {
    if (values.library === undefined || values.genome !== undefined) throw new Error('spacer analyze requires --library and uses its positional input as the genome.');
  } else {
    if (values.genome === undefined || values.library !== undefined || values.host !== undefined || values.mismatches !== undefined) {
      throw new Error('spacer replay requires --genome and cannot override the saved library or search settings.');
    }
  }
  const stdin = [input, values.library, values.genome].filter(value => value === '-').length;
  if (stdin > 1) throw new Error('Only one spacer input may read from stdin (-).');
  return { operation: operation as SpacerCommandOperation, input, library: values.library, genome: values.genome,
    hostId: values.host, maxMismatches: mismatches, topology: topology as SpacerGenome['topology'], topologyExplicit,
    format: format as SpacerCommand['format'], output: values.output === '-' ? undefined : values.output };
}

function spacerWrite(stream: Writable, content: string): Promise<void> {
  return new Promise((resolveWrite, reject) => {
    const fail = (cause: Error) => { stream.off('error', fail); reject(cause); };
    stream.once('error', fail);
    stream.write(content, cause => {
      if (cause) { reject(cause); return; }
      stream.off('error', fail); resolveWrite();
    });
  });
}
async function spacerNewOutput(filename: string): Promise<void> {
  try { await lstat(filename); } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw cause;
  }
  throw new Error('Output already exists; choose a new file. Existing files are never overwritten.');
}
function spacerClean(cause: unknown): string {
  return spacerTerminalLabel(cause instanceof Error ? cause.message : String(cause));
}

export async function runSpacerCommand(args: string[], io: SpacerCommandIO): Promise<number> {
  let command: SpacerCommand | null;
  try { command = parseSpacerCommand(args); }
  catch (cause) { await spacerWrite(io.stderr, 'Spacer: ' + spacerClean(cause) + '\n'); return 2; }
  if (!command) { await spacerWrite(io.stdout, SPACER_COMMAND_HELP); return 0; }
  try {
    check(io.signal);
    const destination = command.output ? resolve(command.output) : undefined;
    if (destination) await spacerNewOutput(destination);
    const read = (filename: string, limit: number) => filename === '-'
      ? readAbundanceStdin(io.stdin, limit, io.signal) : readTerminalSpacerFile(filename, limit, io.signal);
    const primaryLimit = command.operation === 'inspect' ? SPACER_LIMITS.libraryBytes
      : command.operation === 'replay' ? SPACER_RECORD_LIMIT : SPACER_GENOME_FILE_LIMIT;
    const input = await read(command.input, primaryLimit);
    const library = command.library === undefined ? undefined
      : { name: basename(command.library), text: await read(command.library, SPACER_LIMITS.libraryBytes) };
    const genome = command.genome === undefined ? undefined
      : { name: basename(command.genome), text: await read(command.genome, SPACER_GENOME_FILE_LIMIT) };
    check(io.signal);
    const progress = (phase: string) => {
      void spacerWrite(io.stderr, JSON.stringify({ operation: command!.operation, phase: spacerClean(phase) }) + '\n').catch(() => {});
    };
    const result = await (io.execute ?? runSpacerHeadlessJob)({
      operation: command.operation, input: { name: basename(command.input), text: input }, library, genome,
      hostId: command.hostId, maxMismatches: command.maxMismatches, topology: command.topology,
      topologyExplicit: command.topologyExplicit,
    }, io.signal, progress);
    check(io.signal);
    const output = command.format === 'tsv' ? result.tsv : result.content + '\n';
    if (output === null) throw new Error('TSV export requires analyzed or replayed spacer evidence.');
    if (destination) await writeFile(destination, output, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    else await spacerWrite(io.stdout, output);
    return 0;
  } catch (cause) {
    await spacerWrite(io.stderr, 'Spacer: ' + spacerClean(cause) + '\n');
    return io.signal?.aborted || cause instanceof Error && cause.name === 'AbortError' ? 130 : 1;
  }
}

export async function runSpacerProcess(args: string[]): Promise<void> {
  const controller = new AbortController(); let terminated = false;
  const interrupt = () => controller.abort();
  const terminate = () => { terminated = true; controller.abort(); };
  process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
  try {
    const code = await runSpacerCommand(args, { stdin: process.stdin, stdout: process.stdout,
      stderr: process.stderr, signal: controller.signal });
    process.exitCode = code === 130 && terminated ? 143 : code;
  } finally {
    process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); process.stdin.pause();
  }
}
