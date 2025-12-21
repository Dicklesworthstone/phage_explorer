/**
 * Chaos Game Representation (CGR) Core Logic
 *
 * Transforms DNA sequences into 2D fractal fingerprints using an Iterated Function System (IFS).
 */

export interface CGRConfig {
  resolution: number; // Grid size (2^k), e.g., 64 for k=6
  normalize?: boolean;
  logScale?: boolean;
}

export interface CGRResult {
  grid: Float32Array;
  resolution: number;
  k: number;
  maxCount: number;
  totalPoints: number;
  entropy: number;
}

const CORNERS = {
  A: { x: 0, y: 0 },
  T: { x: 1, y: 0 },
  C: { x: 0, y: 1 },
  G: { x: 1, y: 1 },
} as const;

/**
 * Compute CGR fractal fingerprint for a sequence
 */
export function computeCGR(sequence: string, k: number = 6): CGRResult {
  const resolution = Math.pow(2, k);
  const grid = new Float32Array(resolution * resolution);
  let maxCount = 0;
  let totalPoints = 0;

  // Current position in unit square
  let x = 0.5;
  let y = 0.5;

  const seq = sequence.toUpperCase();

  for (let i = 0; i < seq.length; i++) {
    const char = seq[i];
    const corner = CORNERS[char as keyof typeof CORNERS];

    // Skip non-ACGT characters
    if (!corner) continue;

    // Move halfway to corner
    x = (x + corner.x) / 2;
    y = (y + corner.y) / 2;

    // Only start plotting after k steps (transient removal)
    if (i >= k - 1) {
      // Map to grid coordinates
      // Clamp independently to prevent row wrapping artifacts at x=1.0 or y=1.0
      const gridX = Math.min(Math.floor(x * resolution), resolution - 1);
      const gridY = Math.min(Math.floor(y * resolution), resolution - 1);
      
      const idx = gridY * resolution + gridX;
      
      grid[idx]++;
      maxCount = Math.max(maxCount, grid[idx]);
      totalPoints++;
    }
  }

  // Compute entropy
  let entropy = 0;
  if (totalPoints > 0) {
    for (let i = 0; i < grid.length; i++) {
      if (grid[i] > 0) {
        const p = grid[i] / totalPoints;
        entropy -= p * Math.log2(p);
      }
    }
  }

  return {
    grid,
    resolution,
    k,
    maxCount,
    totalPoints,
    entropy,
  };
}

/**
 * Get coordinates for a specific k-mer (reverse CGR)
 */
export function getKmerCoordinates(kmer: string): { x: number; y: number } {
  const k = kmer.length;
  let xMin = 0, xMax = 1;
  let yMin = 0, yMax = 1;

  // Process from last character to first (reverse IFS) to find the specific quadrant
  // Actually, standard CGR usually maps forward.
  // Let's stick to the standard definition:
  // A = top-left (0,0), T = top-right (1,0), C = bottom-left (0,1), G = bottom-right (1,1)
  // 
  // For k=1:
  // A is in [0, 0.5] x [0, 0.5]
  // T is in [0.5, 1] x [0, 0.5]
  // 
  // This matches the quadrant subdivision logic.
  
  for (let i = k - 1; i >= 0; i--) {
    const char = kmer[i].toUpperCase();
    const halfX = (xMax - xMin) / 2;
    const halfY = (yMax - yMin) / 2;

    if (char === 'T' || char === 'G') {
      xMin += halfX;
    } else {
      xMax -= halfX;
    }

    if (char === 'C' || char === 'G') {
      yMin += halfY;
    } else {
      yMax -= halfY;
    }
  }

  return {
    x: (xMin + xMax) / 2,
    y: (yMin + yMax) / 2,
  };
}
