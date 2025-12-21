/**
 * Non-B DNA Structure Detection
 *
 * Detects G-quadruplexes (G4) using G4Hunter and Z-DNA using dinucleotide propensity.
 */

export interface NonBStructure {
  type: 'G4' | 'Z-DNA';
  start: number;
  end: number;
  strand: '+' | '-' | 'both';
  score: number;
  sequence: string;
}

/**
 * G4Hunter Algorithm
 * Score = sum(G_contribution - C_contribution) / window_size
 * G-runs contribute +1 to +4 based on length
 * C-runs contribute -1 to -4
 */
function getG4Score(base: string, runLength: number): number {
  const score = Math.min(4, runLength); // Cap at 4
  return base === 'G' ? score : -score;
}

export function detectG4(sequence: string, windowSize = 25, threshold = 1.5): NonBStructure[] {
  const seq = sequence.toUpperCase();
  const structures: NonBStructure[] = [];
  
  // Precompute scores for each position based on run context
  const scores = new Float32Array(seq.length);
  
  let currentRun = 0;
  let currentBase = '';
  
  // First pass: identify runs
  for (let i = 0; i < seq.length; i++) {
    const base = seq[i];
    if (base === 'G' || base === 'C') {
      if (base === currentBase) {
        currentRun++;
      } else {
        // Fill previous run
        if (currentBase) {
          const score = getG4Score(currentBase, currentRun);
          for (let j = 1; j <= currentRun; j++) {
            scores[i - j] = score;
          }
        }
        currentBase = base;
        currentRun = 1;
      }
    } else {
      if (currentBase) {
        const score = getG4Score(currentBase, currentRun);
        for (let j = 1; j <= currentRun; j++) {
          scores[i - j] = score;
        }
      }
      currentBase = '';
      currentRun = 0;
      scores[i] = 0;
    }
  }
  
  // Fill last run
  if (currentBase) {
    const score = getG4Score(currentBase, currentRun);
    for (let j = 1; j <= currentRun; j++) {
      scores[seq.length - j] = score;
    }
  }

  // Sliding window
  let windowSum = 0;
  // Initialize first window
  for (let i = 0; i < Math.min(windowSize, seq.length); i++) {
    windowSum += scores[i];
  }

  let inRegion = false;
  let regionStart = 0;
  let maxScore = 0;

  for (let i = 0; i <= seq.length - windowSize; i++) {
    const avgScore = windowSum / windowSize;
    const absScore = Math.abs(avgScore);
    
    if (absScore >= threshold) {
      if (!inRegion) {
        inRegion = true;
        regionStart = i;
        maxScore = absScore;
      } else {
        maxScore = Math.max(maxScore, absScore);
      }
    } else if (inRegion) {
      inRegion = false;
      // Last valid window was at i-1.
      // Window range: [i-1, i-1 + windowSize)
      // Inclusive end: i-1 + windowSize - 1 = i + windowSize - 2
      const regionEnd = i + windowSize - 2;
      // Determine strand based on sign of sum
      // Positive sum -> G-rich -> + strand G4
      // Negative sum -> C-rich -> - strand G4 (G-rich on complement)
      // Recalculate sum for the specific region
      const regionSum = scores.slice(regionStart, regionEnd + 1).reduce((a, b) => a + b, 0);
      
      structures.push({
        type: 'G4',
        start: regionStart,
        end: regionEnd,
        strand: regionSum > 0 ? '+' : '-',
        score: maxScore,
        sequence: seq.slice(regionStart, regionEnd + 1),
      });
    }

    // Slide window
    if (i < seq.length - windowSize) {
      windowSum -= scores[i];
      windowSum += scores[i + windowSize];
    }
  }

  if (inRegion) {
    const regionEnd = seq.length - 1;
    let regionSum = 0;
    for (let i = regionStart; i <= regionEnd; i++) {
      regionSum += scores[i];
    }
    structures.push({
      type: 'G4',
      start: regionStart,
      end: regionEnd,
      strand: regionSum > 0 ? '+' : '-',
      score: maxScore,
      sequence: seq.slice(regionStart, regionEnd + 1),
    });
  }

  return structures;
}

/**
 * Z-DNA Detection
 * Based on dinucleotide Z-scores
 * CG = 1.0, CA/TG = 0.5, GC = 0.4, others low/negative
 */
const Z_SCORES: Record<string, number> = {
  'CG': 1.0,
  'CA': 0.5, 'TG': 0.5, 'AC': 0.5, 'GT': 0.5, // TG/AC are CA/GT on complement
  'GC': 0.4,
  'AT': -0.1, 'TA': -0.1,
  'AA': -0.5, 'TT': -0.5, 'GG': -0.5, 'CC': -0.5, // Homo-dinucleotides bad
  'AG': -0.5, 'GA': -0.5, 'CT': -0.5, 'TC': -0.5, // Purine-Purine / Pyrimidine-Pyrimidine bad
};

export function detectZDNA(sequence: string, windowSize = 12, threshold = 0.5): NonBStructure[] {
  const seq = sequence.toUpperCase();
  const structures: NonBStructure[] = [];
  const zPropensity = new Float32Array(seq.length);

  for (let i = 0; i < seq.length - 1; i++) {
    const dinuc = seq.slice(i, i + 2);
    zPropensity[i] = Z_SCORES[dinuc] ?? 0;
  }

  // Sliding window
  let windowSum = 0;
  for (let i = 0; i < Math.min(windowSize, seq.length); i++) {
    windowSum += zPropensity[i];
  }

  let inRegion = false;
  let regionStart = 0;
  let maxScore = 0;

  for (let i = 0; i <= seq.length - windowSize; i++) {
    const avgScore = windowSum / windowSize;
    
    if (avgScore >= threshold) {
      if (!inRegion) {
        inRegion = true;
        regionStart = i;
        maxScore = avgScore;
      } else {
        maxScore = Math.max(maxScore, avgScore);
      }
    } else if (inRegion) {
      inRegion = false;
      // Last valid window at i-1. Inclusive end = i + windowSize - 2
      const regionEnd = i + windowSize - 2;
      structures.push({
        type: 'Z-DNA',
        start: regionStart,
        end: regionEnd,
        strand: 'both', // Z-DNA involves both strands
        score: maxScore,
        sequence: seq.slice(regionStart, regionEnd + 1),
      });
    }

    // Slide window
    if (i < seq.length - windowSize) {
      windowSum -= zPropensity[i];
      windowSum += zPropensity[i + windowSize];
    }
  }

  if (inRegion) {
    const regionEnd = seq.length - 1;
    structures.push({
      type: 'Z-DNA',
      start: regionStart,
      end: regionEnd,
      strand: 'both',
      score: maxScore,
      sequence: seq.slice(regionStart, regionEnd + 1),
    });
  }

  return structures;
}

/**
 * Run full non-B DNA analysis
 */
export function analyzeNonBDNA(sequence: string): NonBStructure[] {
  const g4 = detectG4(sequence);
  const zDna = detectZDNA(sequence);
  return [...g4, ...zDna].sort((a, b) => a.start - b.start);
}
