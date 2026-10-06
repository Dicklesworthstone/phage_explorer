import { parentPort, workerData } from 'node:worker_threads';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename } from 'node:path';
import { importLocalGenomes, GENOME_IMPORT_LIMITS, type GenomeImportResult } from '../../core/src/genome-import';

/** No shell expansion or catalog access. A growing file cannot exceed the byte limit. */
export async function readTerminalGenomeFile(path: string): Promise<GenomeImportResult> {
  if (typeof path !== 'string' || !path || /[\u0000-\u001f\u007f-\u009f]/.test(path)) throw new Error('Provide a local file path without control characters.');
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let text: string;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('Genome input must be a regular file, not a directory, pipe or device.');
    if (stat.size > GENOME_IMPORT_LIMITS.bytes) throw new Error('Genome input exceeds 10 MiB.');
    const bytes = Buffer.alloc(GENOME_IMPORT_LIMITS.bytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > GENOME_IMPORT_LIMITS.bytes) throw new Error('Genome input exceeds 10 MiB.');
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
  } finally { await file.close(); }
  return importLocalGenomes({ name: basename(path), text });
}

if (parentPort) {
  const port = parentPort;
  void readTerminalGenomeFile(workerData?.path)
    .then(result => port.postMessage({ kind: 'result', result }))
    .catch((cause: unknown) => port.postMessage({ kind: 'error', message: cause instanceof Error ? cause.message : 'Genome import failed.' }));
}
