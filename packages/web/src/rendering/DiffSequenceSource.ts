/**
 * DiffSequenceSource - Wrapper for sequence comparison rendering
 *
 * Encapsulates primary and secondary sequences with a diff mask for
 * visual comparison in the SequenceGrid.
 */

/**
 * Diff mask codes:
 * - 0: Match (rendered dimmed)
 * - 1: Substitution (yellow highlight)
 * - 2: Insertion (green highlight, present in primary but not secondary)
 * - 3: Deletion (red highlight with gap marker, missing in primary)
 */
export type DiffCode = 0 | 1 | 2 | 3;

export interface DiffStats {
  matches: number;
  substitutions: number;
  insertions: number;
  deletions: number;
  identity: number;
  lengthA: number;
  lengthB: number;
}

export interface DiffPosition {
  index: number;
  code: DiffCode;
  primaryChar: string;
  secondaryChar: string;
}

export class DiffSequenceSource {
  private primarySequence: string;
  private secondarySequence: string;
  private diffMask: Uint8Array;
  private diffPositions: number[];
  private stats: DiffStats;

  constructor(primarySequence: string, secondarySequence: string, precomputedMask?: Uint8Array) {
    this.primarySequence = primarySequence;
    this.secondarySequence = secondarySequence;

    if (precomputedMask && precomputedMask.length === primarySequence.length) {
      this.diffMask = precomputedMask;
      const { positions, stats } = this.computeStatsFromMask(precomputedMask, primarySequence, secondarySequence);
      this.diffPositions = positions;
      this.stats = stats;
    } else {
      const { mask, positions, stats } = this.computeDiff(primarySequence, secondarySequence);
      this.diffMask = mask;
      this.diffPositions = positions;
      this.stats = stats;
    }
  }

  /**
   * Compute diff mask by simple character comparison
   * For aligned sequences of equal length
   */
  private computeDiff(primary: string, secondary: string): {
    mask: Uint8Array;
    positions: number[];
    stats: DiffStats;
  } {
    const length = primary.length;
    const mask = new Uint8Array(length);
    const positions: number[] = [];
    let matches = 0;
    let substitutions = 0;

    for (let i = 0; i < length; i++) {
      const pChar = primary[i]?.toUpperCase() ?? '';
      const sChar = secondary[i]?.toUpperCase() ?? '';

      if (i >= secondary.length) {
        // Primary extends beyond secondary - treat as insertion
        mask[i] = 2;
        positions.push(i);
      } else if (pChar === sChar) {
        mask[i] = 0;
        matches++;
      } else {
        // Substitution
        mask[i] = 1;
        substitutions++;
        positions.push(i);
      }
    }

    const identity = length > 0 ? (matches / length) * 100 : 100;

    return {
      mask,
      positions,
      stats: {
        matches,
        substitutions,
        insertions: 0,
        deletions: 0,
        identity,
        lengthA: primary.length,
        lengthB: secondary.length,
      },
    };
  }

  /**
   * Compute stats from a precomputed mask (e.g., from alignment algorithm)
   */
  private computeStatsFromMask(
    mask: Uint8Array,
    primary: string,
    secondary: string
  ): { positions: number[]; stats: DiffStats } {
    const positions: number[] = [];
    let matches = 0;
    let substitutions = 0;
    let insertions = 0;
    let deletions = 0;

    for (let i = 0; i < mask.length; i++) {
      const code = mask[i] as DiffCode;
      switch (code) {
        case 0:
          matches++;
          break;
        case 1:
          substitutions++;
          positions.push(i);
          break;
        case 2:
          insertions++;
          positions.push(i);
          break;
        case 3:
          deletions++;
          positions.push(i);
          break;
      }
    }

    const total = matches + substitutions + insertions + deletions;
    const identity = total > 0 ? (matches / total) * 100 : 100;

    return {
      positions,
      stats: {
        matches,
        substitutions,
        insertions,
        deletions,
        identity,
        lengthA: primary.length,
        lengthB: secondary.length,
      },
    };
  }

  /**
   * Get the primary sequence for display
   */
  getPrimarySequence(): string {
    return this.primarySequence;
  }

  /**
   * Get the secondary (reference) sequence
   */
  getSecondarySequence(): string {
    return this.secondarySequence;
  }

  /**
   * Get the diff mask array (0=match, 1=sub, 2=ins, 3=del)
   */
  getDiffMask(): Uint8Array {
    return this.diffMask;
  }

  /**
   * Get sorted list of positions with differences (for navigation)
   */
  getDiffPositions(): number[] {
    return this.diffPositions;
  }

  /**
   * Get statistics about the diff
   */
  getStats(): DiffStats {
    return this.stats;
  }

  /**
   * Get diff code at a specific position
   */
  getDiffCodeAt(index: number): DiffCode {
    if (index < 0 || index >= this.diffMask.length) return 0;
    return this.diffMask[index] as DiffCode;
  }

  /**
   * Get detailed diff info at a position
   */
  getDiffAt(index: number): DiffPosition {
    return {
      index,
      code: this.getDiffCodeAt(index),
      primaryChar: this.primarySequence[index] ?? '',
      secondaryChar: this.secondarySequence[index] ?? '',
    };
  }

  /**
   * Find next diff position from a given index
   */
  findNextDiff(fromIndex: number): number | null {
    for (const pos of this.diffPositions) {
      if (pos > fromIndex) return pos;
    }
    // Wrap to start
    return this.diffPositions.length > 0 ? this.diffPositions[0] : null;
  }

  /**
   * Find previous diff position from a given index
   */
  findPrevDiff(fromIndex: number): number | null {
    for (let i = this.diffPositions.length - 1; i >= 0; i--) {
      if (this.diffPositions[i] < fromIndex) return this.diffPositions[i];
    }
    // Wrap to end
    return this.diffPositions.length > 0 ? this.diffPositions[this.diffPositions.length - 1] : null;
  }

  /**
   * Check if sequences have any differences
   */
  hasDifferences(): boolean {
    return this.diffPositions.length > 0;
  }

  /**
   * Get total number of differences
   */
  getDiffCount(): number {
    return this.diffPositions.length;
  }
}

export default DiffSequenceSource;
