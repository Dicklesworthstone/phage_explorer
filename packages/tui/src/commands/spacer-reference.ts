/** Native transport and file boundaries for the shared spacer-reference workspace. */
import type { TerminalAcrRequest, TerminalAcrResult, TerminalAcrMessage } from './acr-heuristic';
import { Worker } from 'node:worker_threads';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { stripVTControlCharacters } from 'node:util';
import type { SpacerWorker, SpacerMessage, SpacerWorkResult } from '../../../web/src/workers/SpacerReferenceSession';

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
