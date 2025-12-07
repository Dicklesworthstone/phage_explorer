// Quick overlay computations for GC skew, complexity, bendability, promoters, repeats.
// These are lightweight, computed once per loaded phage sequence.

export type OverlayId = 'gcSkew' | 'complexity' | 'bendability' | 'promoter' | 'repeats';

export interface NumericOverlay {
  id: OverlayId;
  label: string;
  values: number[]; // normalized 0..1
  width: number; // number of windows
}

export interface MarkOverlay {
  id: OverlayId;
  label: string;
  positions: number[]; // absolute base positions of marks
}

export type OverlayResult = NumericOverlay | MarkOverlay;

// Utility: normalize array to 0..1
function normalize(values: number[]): number[] {
  if (values.length === 0) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return values.map(() => 0.5);
  return values.map(v => (v - min) / (max - min));
}

// Sliding window helper
function sliding(sequence: string, window: number, fn: (chunk: string) => number): number[] {
  const values: number[] = [];
  for (let i = 0; i <= sequence.length - window; i += window) {
    const chunk = sequence.slice(i, i + window);
    values.push(fn(chunk));
  }
  return values;
}

export function computeGCskew(sequence: string, window = 500): NumericOverlay {
  const values = sliding(sequence, window, (chunk) => {
    let g = 0, c = 0;
    for (const ch of chunk) {
      if (ch === 'G' || ch === 'g') g++;
      else if (ch === 'C' || ch === 'c') c++;
    }
    const denom = g + c || 1;
    return (g - c) / denom; // -1..1
  });
  return { id: 'gcSkew', label: 'GC skew', values: normalize(values), width: values.length };
}

export function computeComplexity(sequence: string, window = 500): NumericOverlay {
  const values = sliding(sequence, window, (chunk) => {
    const freq: Record<string, number> = {};
    for (const ch of chunk) {
      if (!'ACGTacgt'.includes(ch)) continue;
      const u = ch.toUpperCase();
      freq[u] = (freq[u] ?? 0) + 1;
    }
    const total = chunk.length || 1;
    let h = 0;
    for (const v of Object.values(freq)) {
      const p = v / total;
      h -= p * Math.log2(p);
    }
    return h; // 0..2 for DNA
  });
  return { id: 'complexity', label: 'Shannon complexity', values: normalize(values), width: values.length };
}

export function computeBendability(sequence: string, window = 400): NumericOverlay {
  // Simple proxy: AT-rich regions are generally more bendable.
  const values = sliding(sequence, window, (chunk) => {
    let at = 0, gc = 0;
    for (const ch of chunk) {
      const u = ch.toUpperCase();
      if (u === 'A' || u === 'T') at++;
      else if (u === 'G' || u === 'C') gc++;
    }
    const total = at + gc || 1;
    return at / total; // 0..1
  });
  return { id: 'bendability', label: 'AT bendability proxy', values: normalize(values), width: values.length };
}

export function computePromoterMarks(sequence: string): MarkOverlay {
  const marks: number[] = [];
  const motifs = ['TATAAT', 'TTGACA', 'AGGAGG']; // -10, -35, RBS Shine-Dalgarno
  for (let i = 0; i < sequence.length - 6; i++) {
    const sub = sequence.slice(i, i + 6).toUpperCase();
    if (motifs.includes(sub)) {
      marks.push(i);
    }
  }
  return { id: 'promoter', label: 'Promoter/RBS motifs', positions: marks };
}

export function computeRepeatMarks(sequence: string, minLen = 6): MarkOverlay {
  const marks: number[] = [];
  const seq = sequence.toUpperCase();
  // naive palindrome finder for short repeats
  for (let i = 0; i < seq.length - minLen; i++) {
    for (let len = minLen; len <= minLen + 4 && i + len <= seq.length; len++) {
      const sub = seq.slice(i, i + len);
      const revComp = sub.split('').reverse().map((c) => {
        if (c === 'A') return 'T';
        if (c === 'T') return 'A';
        if (c === 'C') return 'G';
        if (c === 'G') return 'C';
        return c;
      }).join('');
      if (sub === revComp) {
        marks.push(i);
        break;
      }
    }
  }
  return { id: 'repeats', label: 'Repeats/Palindromes', positions: marks };
}

export function computeAllOverlays(sequence: string): Record<OverlayId, OverlayResult> {
  return {
    gcSkew: computeGCskew(sequence),
    complexity: computeComplexity(sequence),
    bendability: computeBendability(sequence),
    promoter: computePromoterMarks(sequence),
    repeats: computeRepeatMarks(sequence),
  };
}
