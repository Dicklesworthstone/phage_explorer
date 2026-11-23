import { CHUNK_SIZE } from './types';

export interface SequenceChunk {
  chunkIndex: number;
  sequence: string;
}

/**
 * Read an exact, zero-based half-open interval from fixed-width sequence chunks.
 * Missing or malformed chunks are read failures, never permission to move later
 * bases into their coordinates. Only the terminal chunk may be shorter than
 * CHUNK_SIZE, and its length must agree with the declared genome length.
 */
export async function readSequenceWindowFromChunks(
  start: number,
  end: number,
  readLength: () => Promise<number>,
  readChunks: (first: number, last: number) => Promise<readonly SequenceChunk[]>,
): Promise<string> {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    throw new Error('Invalid sequence window coordinates: expected non-negative safe integers with start <= end.');
  }
  if (start === end) return '';

  const genomeLength = await readLength();
  if (!Number.isSafeInteger(genomeLength) || genomeLength < 0) {
    throw new Error('Invalid genome length; an exact sequence window cannot be read.');
  }
  // Unknown genomes and windows wholly beyond the genome have no bases.
  if (start >= genomeLength) return '';
  const stop = Math.min(end, genomeLength);
  const first = Math.floor(start / CHUNK_SIZE);
  const last = Math.floor((stop - 1) / CHUNK_SIZE);
  const count = last - first + 1;
  const chunks = await readChunks(first, last);
  if (!Array.isArray(chunks) || chunks.length !== count) {
    throw new Error('Incomplete genome sequence: missing or duplicate chunks in the requested interval.');
  }

  const pieces = Array.from({ length: count }, (_, offset) => {
    const chunk = chunks[offset];
    const index = first + offset;
    const expectedLength = Math.min(CHUNK_SIZE, genomeLength - index * CHUNK_SIZE);
    if (!chunk || chunk.chunkIndex !== index || typeof chunk.sequence !== 'string'
      || chunk.sequence.length !== expectedLength) {
      throw new Error('Incomplete genome sequence: chunk ' + index + ' has an invalid index or length.');
    }
    const from = index === first ? start - index * CHUNK_SIZE : 0;
    const to = index === last ? stop - index * CHUNK_SIZE : expectedLength;
    return chunk.sequence.slice(from, to);
  });
  return pieces.join('');
}
