/**
 * Hilbert Curve Genome Atlas
 *
 * Maps 1D genome sequence to 2D using a Hilbert space-filling curve.
 * Preserves locality: adjacent bases stay adjacent in 2D.
 */

export interface HilbertConfig {
  order: number; // Curve order (grid size = 2^order)
  windowSize?: number; // Bases per pixel/point (for large genomes)
}

export interface HilbertPoint {
  x: number;
  y: number;
  d: number; // Distance along curve (index)
}

/**
 * Convert distance d along Hilbert curve of order n to (x, y) coordinates.
 * Grid size is N x N where N = 2^n.
 */
export function hilbertD2XY(n: number, d: number): { x: number; y: number } {
  let rx: number, ry: number, t = d;
  let x = 0;
  let y = 0;

  for (let s = 1; s < (1 << n); s *= 2) {
    rx = 1 & (t / 2);
    ry = 1 & (t ^ rx);
    const rotated = rotate(s, x, y, rx, ry);
    x = rotated.x;
    y = rotated.y;
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return { x, y };
}

/**
 * Rotate/flip a quadrant appropriately
 */
function rotate(n: number, x: number, y: number, rx: number, ry: number): { x: number; y: number } {
  if (ry === 0) {
    if (rx === 1) {
      x = n - 1 - x;
      y = n - 1 - y;
    }
    // Swap x and y
    const temp = x;
    x = y;
    y = temp;
  }
  return { x, y };
}

/**
 * Generate Hilbert curve points for a given sequence length
 */
export function generateHilbertPoints(length: number, order: number): Float32Array {
  // Returns interleaved [x, y, x, y, ...]
  // Normalized to [0, 1] range? No, integer grid coordinates [0, 2^n - 1]
  
  const points = new Float32Array(length * 2);
  for (let i = 0; i < length; i++) {
    const { x, y } = hilbertD2XY(order, i);
    points[i * 2] = x;
    points[i * 2 + 1] = y;
  }
  return points;
}

/**
 * Compute GC content map on Hilbert curve
 */
export function computeHilbertGC(sequence: string, order: number): { grid: Float32Array; size: number } {
  const size = 1 << order; // 2^order
  const grid = new Float32Array(size * size); // Stores GC content (0-1)
  // Initialize with -1 (empty)
  grid.fill(-1);

  const seq = sequence.toUpperCase();
  const len = seq.length;
  
  // One base per point? Or windowed?
  // If len > size*size, we need to bin.
  // If len < size*size, points are sparse.
  
  const pointsPerCell = len / (size * size);
  
  if (pointsPerCell <= 1) {
    // Sparse or 1:1 mapping
    for (let i = 0; i < len; i++) {
      const { x, y } = hilbertD2XY(order, i);
      const base = seq[i];
      const isGC = base === 'G' || base === 'C';
      grid[y * size + x] = isGC ? 1 : 0;
    }
  } else {
    // Binning (multiple bases per cell)
    // Each cell corresponds to a range of 'd'
    for (let i = 0; i < size * size; i++) {
      const start = Math.floor(i * pointsPerCell);
      const end = Math.min(len, Math.floor((i + 1) * pointsPerCell));
      if (start >= len) break;
      
      let gcCount = 0;
      let total = 0;
      for (let j = start; j < end; j++) {
        const base = seq[j];
        if (base === 'G' || base === 'C') gcCount++;
        total++;
      }
      
      const { x, y } = hilbertD2XY(order, i);
      grid[y * size + x] = total > 0 ? gcCount / total : 0;
    }
  }

  return { grid, size };
}
