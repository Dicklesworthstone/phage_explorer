
export interface TranscriptionWindowStat {
  start: number;
  end: number;
  flux: number;
}

export interface TranscriptionAnalysis {
  values: number[];
  peaks: TranscriptionWindowStat[];
}

export function findPromoters(seq: string): Array<{ pos: number; strength: number; motif: string }> {
  const motifs = ['TATAAT', 'TTGACA', 'AGGAGG'];
  const hits: Array<{ pos: number; strength: number; motif: string }> = [];
  const upper = seq.toUpperCase();
  for (let i = 0; i <= upper.length - 6; i++) {
    const sub = upper.slice(i, i + 6);
    if (motifs.includes(sub)) {
      const strength = sub === 'TTGACA' || sub === 'TATAAT' ? 1 : 0.6;
      hits.push({ pos: i, strength, motif: sub });
    }
  }
  return hits;
}

export function findTerminators(seq: string): Array<{ pos: number; efficiency: number }> {
  const hits: Array<{ pos: number; efficiency: number }> = [];
  const upper = seq.toUpperCase();
  const revCompChar = (c: string) => (c === 'A' ? 'T' : c === 'T' ? 'A' : c === 'C' ? 'G' : c === 'G' ? 'C' : c);
  for (let i = 0; i <= upper.length - 6; i++) {
    for (let len = 6; len <= 10 && i + len <= upper.length; len++) {
      const sub = upper.slice(i, i + len);
      const rev = sub.split('').reverse().map(revCompChar).join('');
      if (sub === rev) {
        hits.push({ pos: i, efficiency: 0.6 });
        break;
      }
    }
  }
  return hits;
}

export function simulateTranscriptionFlow(seq: string, window = 200): TranscriptionAnalysis {
  if (seq.length === 0) return { values: [], peaks: [] };

  const promoters = findPromoters(seq);
  const terminators = findTerminators(seq);

  const bins = Math.max(1, Math.ceil(seq.length / window));
  const values = new Array(bins).fill(0);

  // Seed promoter flux
  for (const p of promoters) {
    const idx = Math.min(bins - 1, Math.floor(p.pos / window));
    values[idx] += p.strength;
  }

  // Propagate downstream with attenuation at terminators
  for (let i = 1; i < bins; i++) {
    values[i] += values[i - 1];
    const binStart = i * window;
    const termHere = terminators.find(t => t.pos >= binStart && t.pos < binStart + window);
    if (termHere) {
      values[i] *= 1 - termHere.efficiency;
    }
  }

  // Peaks: top 3 bins
  const peaks: TranscriptionWindowStat[] = values
    .map((v, i) => ({
      start: i * window + 1,
      end: Math.min(seq.length, (i + 1) * window),
      flux: v,
    }))
    .sort((a, b) => b.flux - a.flux)
    .slice(0, 3);

  return { values, peaks };
}
