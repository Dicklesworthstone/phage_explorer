
import { reverseComplement } from './codons';

export interface TranscriptionWindowStat {
  start: number;
  end: number;
  flux: number;
}

export interface TranscriptionAnalysis {
  values: number[];
  peaks: TranscriptionWindowStat[];
}

// --- Regulatory motif detection (lightweight PWMs / heuristics) ---
const SIGMA70_MINUS35 = 'TTGACA';
const SIGMA70_MINUS10 = 'TATAAT';
const SIGMA32_MINUS35 = 'TTGAAA';
const SIGMA32_MINUS10 = 'CCCCAT';
const SIGMA54_CORE = 'TGGCACG';
const RBS_PATTERN = /AGGAGG|GGAGG|AGGA|GGAG/gi;

export interface PromoterHit {
  pos: number;
  strength: number; // 0..1
  motif: string;
  strand: '+' | '-';
}

export interface TerminatorHit {
  pos: number;
  efficiency: number; // 0..1
  motif: string;
  strand: '+' | '-';
}

export interface RegulatoryEdge {
  source: number;
  target: number;
  distance: number;
  weight: number; // 0..1
  label: string;
}

export interface RegulatoryConstellation {
  promoters: PromoterHit[];
  terminators: TerminatorHit[];
  edges: RegulatoryEdge[];
}

function scoreExactAt(seq: string, motif: string, offset: number): number {
  let score = 0;
  for (let i = 0; i < motif.length; i++) {
    if (seq[offset + i] === motif[i]) score += 1;
  }
  return score / motif.length;
}

// Helper for scanning a single strand
function scanPromotersOnStrand(seq: string, strand: '+' | '-'): PromoterHit[] {
  const upper = seq.toUpperCase();
  const hits: PromoterHit[] = [];
  const len = upper.length;
  
  // Sigma70: Scan for -10 box, then look for -35
  for (let i = 25; i <= len - 6; i++) {
    // 1. Check -10 box (TATAAT) at i
    const score10 = scoreExactAt(upper, SIGMA70_MINUS10, i);
    
    if (score10 >= 0.8) {
      // 2. Look for -35 box (TTGACA)
      let best35 = 0;
      for (let dist = 21; dist <= 25; dist++) {
        const j = i - dist;
        const score35 = scoreExactAt(upper, SIGMA70_MINUS35, j);
        if (score35 > best35) best35 = score35;
      }
      
      if (best35 >= 0.66) {
        const combined = (score10 + best35) / 2;
        hits.push({ pos: i, strength: combined, motif: 'σ70', strand });
      }
    } else if (score10 >= 0.9) {
       hits.push({ pos: i, strength: score10 * 0.7, motif: 'σ70 (-10 only)', strand });
    }
  }

  // Sigma32 and Sigma54
  for (let i = 0; i <= len - 6; i++) {
    const score32_35 = scoreExactAt(upper, SIGMA32_MINUS35, i);
    const score32_10 = scoreExactAt(upper, SIGMA32_MINUS10, i);
    const score54 = scoreExactAt(upper, SIGMA54_CORE, i);

    if (score32_35 > 0.8 || score32_10 > 0.8) {
      hits.push({ pos: i, strength: Math.max(score32_35, score32_10) * 0.8, motif: 'σ32', strand });
    }
    if (score54 > 0.8) {
      hits.push({ pos: i, strength: score54 * 0.85, motif: 'σ54', strand });
    }
  }

  // RBS (Forward only, usually not relevant for reverse scan unless searching for genes?)
  // For transcription, RBS is secondary. We'll include it for completeness.
  for (const match of upper.matchAll(RBS_PATTERN)) {
    if (match.index === undefined) continue;
    hits.push({ pos: match.index, strength: 0.6 + 0.1 * match[0].length, motif: 'RBS', strand });
  }

  return hits;
}

export function detectPromoters(seq: string): PromoterHit[] {
  const fwd = scanPromotersOnStrand(seq, '+');
  const rc = reverseComplement(seq);
  const rev = scanPromotersOnStrand(rc, '-');

  // Map reverse hits back to forward coordinates
  // pos on RC `i` corresponds to `len - 1 - i` on Forward
  // BUT: Promoter at `i` on RC is 5' end (start) of signal on RC.
  // This corresponds to 3' end on Forward.
  // Does `pos` represent transcription start site (TSS) or motif start?
  // Our scanner finds motif start.
  // Sigma70 -10 box is at `i`. TSS is usually `i + 6 + 6` (approx).
  // Let's just map the motif position directly.
  const len = seq.length;
  const revMapped = rev.map(h => ({
    ...h,
    pos: len - 1 - h.pos // Simple mirroring
  }));

  const all = [...fwd, ...revMapped];

  // Deduplicate overlapping hits, keeping strongest
  const sorted = all.sort((a, b) => b.strength - a.strength);
  const filtered: PromoterHit[] = [];
  
  for (const hit of sorted) {
    const isOverlap = filtered.some(h => h.strand === hit.strand && Math.abs(h.pos - hit.pos) < 10);
    if (!isOverlap) {
      filtered.push(hit);
    }
  }

  const max = Math.max(0.001, ...filtered.map(h => h.strength));
  return filtered
    .map(h => ({ ...h, strength: Math.min(1, h.strength / max) }))
    .sort((a, b) => a.pos - b.pos);
}

// Helper for scanning terminators on single strand
function scanTerminatorsOnStrand(seq: string, strand: '+' | '-'): TerminatorHit[] {
  const upper = seq.toUpperCase();
  const hits: TerminatorHit[] = [];

  for (let i = 0; i <= upper.length - 25; i++) {
    for (let stemLen = 5; stemLen <= 8; stemLen++) {
      const stem1 = upper.slice(i, i + stemLen);
      const gc = stem1.split('').filter(c => c === 'G' || c === 'C').length;
      if (gc / stemLen < 0.5) continue;

      const rcStem = reverseComplement(stem1);

      for (let loopLen = 3; loopLen <= 8; loopLen++) {
        const stem2Start = i + stemLen + loopLen;
        const stem2 = upper.slice(stem2Start, stem2Start + stemLen);

        if (stem2 === rcStem) {
          const tailStart = stem2Start + stemLen;
          const tail = upper.slice(tailStart, tailStart + 5);
          const tCount = tail.split('').filter(c => c === 'T').length;
          
          if (tCount >= 3) {
            const eff = Math.min(1, 0.5 + (gc / stemLen) * 0.3 + (tCount / 5) * 0.2);
            hits.push({ 
              pos: i, 
              efficiency: eff, 
              motif: `term(${stemLen}-${loopLen})`,
              strand
            });
            loopLen = 9; stemLen = 9; 
          }
        }
      }
    }
  }
  return hits;
}

export function detectTerminators(seq: string): TerminatorHit[] {
  const fwd = scanTerminatorsOnStrand(seq, '+');
  const rc = reverseComplement(seq);
  const rev = scanTerminatorsOnStrand(rc, '-');

  const len = seq.length;
  const revMapped = rev.map(h => ({
    ...h,
    pos: len - 1 - h.pos
  }));

  const all = [...fwd, ...revMapped];
  const sorted = all.sort((a, b) => b.efficiency - a.efficiency);
  const filtered: TerminatorHit[] = [];
  
  for (const hit of sorted) {
    const isOverlap = filtered.some(h => h.strand === hit.strand && Math.abs(h.pos - hit.pos) < 10);
    if (!isOverlap) {
      filtered.push(hit);
    }
  }

  return filtered.sort((a, b) => a.pos - b.pos);
}

export function simulateTranscriptionFlow(seq: string, window = 200): TranscriptionAnalysis {
  if (seq.length === 0) return { values: [], peaks: [] };

  const promoters = detectPromoters(seq);
  const terminators = detectTerminators(seq);

  const bins = Math.max(1, Math.ceil(seq.length / window));
  const fwdFlux = new Array(bins).fill(0);
  const revFlux = new Array(bins).fill(0);

  // Seed promoter flux
  for (const p of promoters) {
    const idx = Math.min(bins - 1, Math.floor(p.pos / window));
    if (p.strand === '+') {
      fwdFlux[idx] += p.strength;
    } else {
      revFlux[idx] += p.strength;
    }
  }

  // Propagate downstream (Forward: 0 -> end)
  for (let i = 1; i < bins; i++) {
    fwdFlux[i] += fwdFlux[i - 1];
    const binStart = i * window;
    const termHere = terminators.find(t => t.strand === '+' && t.pos >= binStart && t.pos < binStart + window);
    if (termHere) {
      fwdFlux[i] *= 1 - termHere.efficiency;
    }
  }

  // Propagate upstream (Reverse: end -> 0)
  for (let i = bins - 2; i >= 0; i--) {
    revFlux[i] += revFlux[i + 1];
    const binStart = i * window;
    const termHere = terminators.find(t => t.strand === '-' && t.pos >= binStart && t.pos < binStart + window);
    if (termHere) {
      revFlux[i] *= 1 - termHere.efficiency;
    }
  }

  // Combine flux (total activity)
  const values = fwdFlux.map((f, i) => f + revFlux[i]);

  // Peaks
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

/**
 * Compute co-occurrence edges between promoters and terminators to capture spacing relationships.
 * Edges are scored higher when distances fall in plausible operon ranges (50-250 bp) and when
 * promoter strength / terminator efficiency are high.
 */
export function computeRegulatoryConstellation(seq: string): RegulatoryConstellation {
  const promoters = detectPromoters(seq);
  const terminators = detectTerminators(seq);
  const edges: RegulatoryEdge[] = [];

  const idealMin = 50;
  const idealMax = 5000;

  for (const p of promoters) {
    for (const t of terminators) {
      if (t.pos <= p.pos) continue; // downstream only
      const dist = t.pos - p.pos;
      // Score based on distance closeness to ideal range
      let distScore = 0;
      if (dist >= idealMin && dist <= idealMax) {
        const mid = (idealMin + idealMax) / 2;
        const span = (idealMax - idealMin) / 2;
        distScore = 1 - Math.min(1, Math.abs(dist - mid) / span);
      } else {
        distScore = Math.max(0, 1 - Math.abs(dist - idealMax) / (idealMax * 2));
      }
      const weight = Math.min(1, (p.strength * 0.6 + (t.efficiency ?? 0.5) * 0.4) * distScore);
      if (weight > 0.15) {
        edges.push({
          source: p.pos,
          target: t.pos,
          distance: dist,
          weight,
          label: `${p.motif}→term`,
        });
      }
    }
  }

  // Also link promoter-promoter clusters (divergent / tandem) if close
  for (let i = 0; i < promoters.length; i++) {
    for (let j = i + 1; j < promoters.length; j++) {
      const dist = Math.abs(promoters[j].pos - promoters[i].pos);
      if (dist > 400) continue;
      const weight = Math.min(1, 0.5 + 0.5 * (1 - dist / 400));
      edges.push({
        source: promoters[i].pos,
        target: promoters[j].pos,
        distance: dist,
        weight,
        label: 'promoter cluster',
      });
    }
  }

  // Normalize weights to 0..1
  const maxW = Math.max(0.001, ...edges.map(e => e.weight));
  const normEdges = edges
    .map(e => ({ ...e, weight: Math.min(1, e.weight / maxW) }))
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 25);

  return { promoters, terminators, edges: normEdges };
}
