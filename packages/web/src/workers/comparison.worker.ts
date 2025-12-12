import type { GenomeComparisonResult } from '@phage-explorer/comparison';
import { compareGenomes } from '@phage-explorer/comparison';

interface ComparisonJob {
  phageA: { id: number; name: string; accession: string };
  phageB: { id: number; name: string; accession: string };
  sequenceA: string;
  sequenceB: string;
  genesA: any[];
  genesB: any[];
  codonUsageA?: any | null;
  codonUsageB?: any | null;
}

interface WorkerMessage {
  ok: boolean;
  result?: GenomeComparisonResult;
  diffMask?: Uint8Array;
  diffPositions?: number[];
  diffStats?: DiffStats;
  error?: string;
}

self.onmessage = async (event: MessageEvent<ComparisonJob>) => {
  const job = event.data;
  const message: WorkerMessage = { ok: false };

  // Validate input
  if (!job || !job.sequenceA || !job.sequenceB) {
    message.error = 'Invalid comparison job: missing required sequences';
    (self as any).postMessage(message);
    return;
  }

  try {
    const result = await compareGenomes(
      job.phageA,
      job.phageB,
      job.sequenceA,
      job.sequenceB,
      job.genesA ?? [],
      job.genesB ?? [],
      job.codonUsageA ?? null,
      job.codonUsageB ?? null
    );

    const diff = computeDiff(job.sequenceA, job.sequenceB);

    message.ok = true;
    message.result = result;
    message.diffMask = diff.mask;
    message.diffPositions = diff.positions;
    message.diffStats = diff.stats;

    // Transfer ArrayBuffer if valid and not empty
    const transferList: Transferable[] = [];
    if (diff.mask.buffer && diff.mask.buffer.byteLength > 0) {
      transferList.push(diff.mask.buffer);
    }

    (self as any).postMessage(message, transferList);
    return;
  } catch (err) {
    if (import.meta.env.DEV) {
      console.error('Comparison worker error:', err);
    }
    message.error = err instanceof Error ? err.message : 'Comparison failed';
  }
  (self as any).postMessage(message);
};

type DiffOp = 'equal' | 'insert' | 'delete' | 'replace';

interface DiffStats {
  insertions: number;
  deletions: number;
  substitutions: number;
  matches: number;
  lengthA: number;
  lengthB: number;
  identity: number;
}

interface DiffComputation {
  mask: Uint8Array;
  positions: number[];
  stats: DiffStats;
}

/**
 * Compute a minimal diff mask using Myers' algorithm.
 * Mask legend: 0 = match, 1 = substitution, 2 = insertion (gap relative to A), 3 = deletion.
 */
function computeDiff(sequenceA: string, sequenceB: string): DiffComputation {
  const n = sequenceA.length;
  const m = sequenceB.length;

  if (n === 0) {
    return {
      mask: new Uint8Array(0),
      positions: [],
      stats: {
        insertions: m,
        deletions: 0,
        substitutions: 0,
        matches: 0,
        lengthA: 0,
        lengthB: m,
        identity: 0,
      },
    };
  }

  // Fast path for equal-length sequences: O(n) exact mismatches, no risk of OOM.
  if (n === m) {
    const mask = new Uint8Array(n);
    const positions: number[] = [];
    let substitutions = 0;
    let matches = 0;

    for (let i = 0; i < n; i++) {
      if (sequenceA[i] === sequenceB[i]) {
        matches++;
      } else {
        mask[i] = 1;
        positions.push(i);
        substitutions++;
      }
    }

    const identity = Math.max(0, Math.min(100, (matches / n) * 100));
    return {
      mask,
      positions,
      stats: {
        insertions: 0,
        deletions: 0,
        substitutions,
        matches,
        lengthA: n,
        lengthB: m,
        identity,
      },
    };
  }

  // Safety fallback for large inputs: avoid Myers trace OOM by using a cheap alignment heuristic.
  const maxLen = Math.max(n, m);
  const sumLen = n + m;
  if (maxLen > 4000 || sumLen > 8000) {
    let prefix = 0;
    const minLen = Math.min(n, m);
    while (prefix < minLen && sequenceA[prefix] === sequenceB[prefix]) prefix++;

    let suffix = 0;
    while (
      suffix < n - prefix &&
      suffix < m - prefix &&
      sequenceA[n - 1 - suffix] === sequenceB[m - 1 - suffix]
    ) {
      suffix++;
    }

    const mask = new Uint8Array(n);
    const diffPositions: number[] = [];
    let substitutions = 0;
    let deletions = 0;
    let insertions = 0;
    let matches = prefix + suffix;

    const aMidStart = prefix;
    const aMidEnd = n - suffix;
    const bMidStart = prefix;
    const bMidEnd = m - suffix;
    const overlap = Math.min(aMidEnd - aMidStart, bMidEnd - bMidStart);

    for (let i = 0; i < overlap; i++) {
      const idxA = aMidStart + i;
      if (sequenceA[idxA] === sequenceB[bMidStart + i]) {
        matches++;
      } else {
        mask[idxA] = 1;
        diffPositions.push(idxA);
        substitutions++;
      }
    }

    for (let idxA = aMidStart + overlap; idxA < aMidEnd; idxA++) {
      mask[idxA] = 3;
      diffPositions.push(idxA);
      deletions++;
    }

    const extraB = (bMidEnd - bMidStart) - overlap;
    if (extraB > 0) {
      insertions += extraB;
      const pos = Math.min(aMidStart + overlap, n - 1);
      if (pos >= 0) {
        if (mask[pos] === 0) {
          mask[pos] = 2;
        }
        diffPositions.push(pos);
      }
    }

    const identity = Math.max(0, Math.min(100, (matches / Math.max(n, m)) * 100));
    const uniquePositions = Array.from(new Set(diffPositions)).sort((a, b) => a - b);
    return {
      mask,
      positions: uniquePositions,
      stats: {
        insertions,
        deletions,
        substitutions,
        matches,
        lengthA: n,
        lengthB: m,
        identity,
      },
    };
  }

  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 1);
  const trace: Int32Array[] = [];

  let distance = 0;
  let success = false;
  
  // Extra guard: even for small sequences, avoid pathological runtimes.
  const MAX_ITERATIONS = 2500;

  outer: for (let d = 0; d <= max; d++) {
    if (d > MAX_ITERATIONS) {
      if (import.meta.env.DEV) {
        console.warn(`Diff computation exceeded max iterations (${MAX_ITERATIONS}). Result truncated.`);
      }
      break;
    }
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset])) {
        x = v[k + 1 + offset];
      } else {
        x = v[k - 1 + offset] + 1;
      }
      let y = x - k;
      while (x < n && y < m && sequenceA[x] === sequenceB[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        trace.push(v.slice());
        distance = d;
        success = true;
        break outer;
      }
    }
    trace.push(v.slice());
  }

  if (!success) {
    // Return empty/partial result if failed
    return {
      mask: new Uint8Array(n),
      positions: [],
      stats: {
        insertions: 0,
        deletions: 0,
        substitutions: 0,
        matches: n,
        lengthA: n,
        lengthB: m,
        identity: 0, 
      },
    };
  }

  type Span = { op: DiffOp; length: number };
  const spans: Span[] = [];
  let x = n;
  let y = m;

  for (let d = distance; d > 0; d--) {
    const k = x - y;
    const vPrev = trace[d - 1];
    let prevK: number;
    if (k === -d || (k !== d && vPrev[k - 1 + offset] < vPrev[k + 1 + offset])) {
      prevK = k + 1; // insertion
    } else {
      prevK = k - 1; // deletion
    }
    const prevX = vPrev[prevK + offset];
    const prevY = prevX - prevK;

    const diagLen = x - prevX;
    if (diagLen > 0) {
      spans.push({ op: 'equal', length: diagLen });
    }

    if (prevK === k + 1) {
      spans.push({ op: 'insert', length: 1 });
    } else {
      spans.push({ op: 'delete', length: 1 });
    }

    x = prevX;
    y = prevY;
  }

  if (x > 0) {
    spans.push({ op: 'equal', length: x });
  }

  spans.reverse();

  // Normalize consecutive insert/delete into replace segments where possible
  const normalized: Span[] = [];
  for (let i = 0; i < spans.length; i++) {
    const current = spans[i];
    const next = spans[i + 1];
    if (
      current &&
      next &&
      ((current.op === 'delete' && next.op === 'insert') || (current.op === 'insert' && next.op === 'delete'))
    ) {
      const subLen = Math.min(current.length, next.length);
      if (subLen > 0) {
        normalized.push({ op: 'replace', length: subLen });
      }
      const remainingDelete = current.op === 'delete' ? current.length - subLen : next.length - subLen;
      const remainingInsert = current.op === 'insert' ? current.length - subLen : next.length - subLen;
      if (remainingDelete > 0) normalized.push({ op: 'delete', length: remainingDelete });
      if (remainingInsert > 0) normalized.push({ op: 'insert', length: remainingInsert });
      i++; // skip paired span
    } else {
      normalized.push(current);
    }
  }

  const mask = new Uint8Array(n);
  const diffPositions: number[] = [];

  let idxA = 0;
  let substitutions = 0;
  let deletions = 0;
  let insertions = 0;

  for (const span of normalized) {
    switch (span.op) {
      case 'equal': {
        idxA += span.length;
        break;
      }
      case 'replace': {
        for (let i = 0; i < span.length; i++) {
          if (idxA < mask.length) {
            mask[idxA] = 1; // substitution
            diffPositions.push(idxA);
          }
          idxA++;
          substitutions++;
        }
        break;
      }
      case 'delete': {
        for (let i = 0; i < span.length; i++) {
          if (idxA < mask.length) {
            mask[idxA] = 3; // deletion from A
            diffPositions.push(idxA);
          }
          idxA++;
          deletions++;
        }
        break;
      }
      case 'insert': {
        for (let i = 0; i < span.length; i++) {
          const pos = Math.min(idxA, mask.length - 1);
          if (pos >= 0 && pos < mask.length) {
            if (mask[pos] === 0) {
              mask[pos] = 2; // insertion relative to A
            }
            diffPositions.push(pos);
          }
          insertions++;
        }
        break;
      }
    }
  }

  const matches = Math.max(0, n - substitutions - deletions);
  const identity = Math.max(0, Math.min(100, (matches / Math.max(n, m)) * 100));

  // Deduplicate and sort diff positions for fast navigation
  const uniquePositions = Array.from(new Set(diffPositions)).sort((a, b) => a - b);

  return {
    mask,
    positions: uniquePositions,
    stats: {
      insertions,
      deletions,
      substitutions,
      matches,
      lengthA: n,
      lengthB: m,
      identity,
    },
  };
}
