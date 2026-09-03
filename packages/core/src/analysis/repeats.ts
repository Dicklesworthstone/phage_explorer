/**
 * Exact JavaScript reference implementations for repeat detection.
 *
 * Implements bit-for-bit parity with WASM kernels:
 * - `detect_palindromes(seq, min_len, max_gap)`
 * - `detect_tandem_repeats(seq, min_unit, max_unit, min_copies)`
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
export function detectPalindromesJS(seq: string, minLen: number, maxGap: number): PalindromeHit[] {
  const bytes = new TextEncoder().encode(seq);
  const n = bytes.length;
  const results: PalindromeHit[] = [];

  if (n < minLen * 2) {
    return results;
  }

  for (let center = minLen; center <= n - minLen; center++) {
    for (let gap = 0; gap <= maxGap; gap++) {
      const halfGap = Math.floor(gap / 2);
      if (center < minLen + halfGap || center + halfGap + minLen > n) {
        continue;
      }

      let armLen = 0;
      const limit = Math.min(n - center - halfGap, center - halfGap);

      for (let offset = 0; offset < limit; offset++) {
        const leftIdx = center - halfGap - offset - 1;
        const rightIdx = center + halfGap + offset;

        if (rightIdx >= n) {
          break;
        }

        if (isComplementBaseCode(bytes[leftIdx], bytes[rightIdx])) {
          armLen = offset + 1;
        } else {
          break;
        }
      }

      if (armLen >= minLen) {
        const start = center - halfGap - armLen;
        const end = center + halfGap + armLen;
        const subseq = seq.slice(start, end);

        results.push({
          start,
          end,
          arm_length: armLen,
          gap,
          sequence: subseq,
        });
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
  minCopies: number
): TandemRepeatHit[] {
  const n = seq.length;
  const results: TandemRepeatHit[] = [];

  if (n < minUnit * minCopies) {
    return results;
  }

  const upper = seq.toUpperCase();

  for (let start = 0; start < n; start++) {
    const maxU = Math.min(maxUnit, n - start);
    for (let unitLen = minUnit; unitLen <= maxU; unitLen++) {
      const unit = upper.slice(start, start + unitLen);
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
      }
    }
  }

  return results;
}
