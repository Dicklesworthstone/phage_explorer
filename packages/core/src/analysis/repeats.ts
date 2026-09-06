/**
 * Exact JavaScript reference implementations for repeat detection.
 *
 * Coordinates are zero-based, end-exclusive. Arms/units must be resolved bases;
 * IUPAC ambiguity is permitted in spacers. Optional limits return a deterministic
 * prefix without constructing the full result on highly repetitive inputs.
 *
 * @see phage_explorer-lru9
 */

export interface PalindromeHit {
  start: number;
  end: number;
  arm_length: number;
  gap: number;
  sequence: string;
}

export interface TandemRepeatHit {
  start: number;
  end: number;
  unit: string;
  copies: number;
  sequence: string;
}

function validateRepeatInput(seq: string, maxResults: number): void {
  if (!/^[ACGTURYSWKMBDHVN]*$/i.test(seq)) throw new RangeError('Repeat input must contain only DNA/RNA IUPAC bases');
  if (!Number.isSafeInteger(maxResults) || maxResults < 0) throw new RangeError('Repeat result limit must be a non-negative integer');
}

/**
 * Check if two ASCII character codes represent complementary RNA/DNA bases.
 * Supports A-T, T-A, G-C, C-G, A-U, U-A (case-insensitive).
 */
export function isComplementBaseCode(a: number, b: number): boolean {
  const ca = a >= 97 && a <= 122 ? a - 32 : a;
  const cb = b >= 97 && b <= 122 ? b - 32 : b;
  return (
    (ca === 65 && cb === 84) || (ca === 84 && cb === 65) || // A-T, T-A
    (ca === 71 && cb === 67) || (ca === 67 && cb === 71) || // G-C, C-G
    (ca === 65 && cb === 85) || (ca === 85 && cb === 65)    // A-U, U-A
  );
}

/**
 * Detect palindromic sequences (inverted repeats with optional central spacer/gap).
 *
 * Exactly matches the algorithm and JSON output structure of WASM `detect_palindromes`.
 *
 * @param seq - Sequence string
 * @param minLen - Minimum arm length
 * @param maxGap - Maximum spacer gap between arms
 */
export function detectPalindromesJS(seq: string, minLen: number, maxGap: number, maxResults = Number.MAX_SAFE_INTEGER): PalindromeHit[] {
  validateRepeatInput(seq, maxResults);
  if (!Number.isSafeInteger(minLen) || minLen < 1 || !Number.isSafeInteger(maxGap) || maxGap < 0) {
    throw new RangeError('Repeat arm length must be positive and spacer length non-negative integers');
  }
  const n = seq.length;
  const results: PalindromeHit[] = [];

  if (minLen > Math.floor(n / 2) || maxResults === 0) {
    return results;
  }

  // The boundary after the left arm also starts the spacer, even for odd gaps.
  for (let leftEnd = minLen; leftEnd <= n - minLen; leftEnd++) {
    for (let gap = 0; gap <= Math.min(maxGap, n - leftEnd - minLen); gap++) {
      let armLen = 0;
      const rightStart = leftEnd + gap;
      const limit = Math.min(n - rightStart, leftEnd);

      for (let offset = 0; offset < limit; offset++) {
        if (isComplementBaseCode(seq.charCodeAt(leftEnd - offset - 1), seq.charCodeAt(rightStart + offset))) {
          armLen = offset + 1;
        } else {
          break;
        }
      }

      if (armLen >= minLen) {
        const start = leftEnd - armLen;
        const end = rightStart + armLen;
        const subseq = seq.slice(start, end);

        results.push({
          start,
          end,
          arm_length: armLen,
          gap,
          sequence: subseq,
        });
        if (results.length >= maxResults) return results;
      }
    }
  }

  return results;
}

/**
 * Detect tandem repeats (consecutive identical unit copies).
 *
 * Exactly matches the algorithm and JSON output structure of WASM `detect_tandem_repeats`.
 *
 * @param seq - Sequence string
 * @param minUnit - Minimum repeat unit length
 * @param maxUnit - Maximum repeat unit length
 * @param minCopies - Minimum number of consecutive copies
 */
export function detectTandemRepeatsJS(
  seq: string,
  minUnit: number,
  maxUnit: number,
  minCopies: number,
  maxResults = Number.MAX_SAFE_INTEGER
): TandemRepeatHit[] {
  validateRepeatInput(seq, maxResults);
  if (!Number.isSafeInteger(minUnit) || minUnit < 1 || !Number.isSafeInteger(maxUnit) || maxUnit < minUnit || !Number.isSafeInteger(minCopies) || minCopies < 2) {
    throw new RangeError('Repeat unit bounds must be positive integers and minimum copies at least two');
  }
  const n = seq.length;
  const results: TandemRepeatHit[] = [];

  if (minUnit > Math.floor(n / minCopies) || maxResults === 0) {
    return results;
  }

  const upper = seq.toUpperCase();

  for (let start = 0; start < n; start++) {
    const maxU = Math.min(maxUnit, n - start);
    for (let unitLen = minUnit; unitLen <= maxU; unitLen++) {
      const unit = upper.slice(start, start + unitLen);
      if (/[^ACGTU]/.test(unit)) continue;
      let copies = 1;
      let pos = start + unitLen;

      while (pos + unitLen <= n) {
        const candidate = upper.slice(pos, pos + unitLen);
        if (candidate === unit) {
          copies++;
          pos += unitLen;
        } else {
          break;
        }
      }

      if (copies >= minCopies) {
        const end = start + copies * unitLen;
        const subseq = seq.slice(start, end);

        results.push({
          start,
          end,
          unit,
          copies,
          sequence: subseq,
        });
        if (results.length >= maxResults) return results;
      }
    }
  }

  return results;
}
