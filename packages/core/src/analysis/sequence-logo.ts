/**
 * Information-theoretic Sequence Logo Analysis
 *
 * Calculates Shannon entropy and information content (bits) for a multiple sequence alignment.
 * Supports DNA (2 bits max) and Protein (4.3 bits max).
 */

export interface LogoColumn {
  position: number;
  totalBits: number; // R(p) - height of the stack
  letters: { char: string; height: number }[]; // Sorted by height ascending
}

export type AlphabetType = 'dna' | 'protein';

const DNA_ALPHABET = ['A', 'C', 'G', 'T'];
const PROTEIN_ALPHABET = [
  'A', 'R', 'N', 'D', 'C', 'Q', 'E', 'G', 'H', 'I',
  'L', 'K', 'M', 'F', 'P', 'S', 'T', 'W', 'Y', 'V'
];

// Small sample correction factor (e_n)
// e(n) = (s - 1) / (2 * ln(2) * n)
function calculateErrorCorrection(numSequences: number, alphabetSize: number): number {
  if (numSequences === 0) return 0;
  return (alphabetSize - 1) / (2 * Math.log(2) * numSequences);
}

export function computeSequenceLogo(
  alignment: string[],
  type: AlphabetType = 'dna'
): LogoColumn[] {
  if (!alignment || alignment.length === 0) return [];

  const numSequences = alignment.length;
  const seqLength = alignment[0].length;
  const alphabet = type === 'dna' ? DNA_ALPHABET : PROTEIN_ALPHABET;
  const maxBits = Math.log2(alphabet.length);
  const errorCorrection = calculateErrorCorrection(numSequences, alphabet.length);

  const columns: LogoColumn[] = [];

  for (let i = 0; i < seqLength; i++) {
    // 1. Count frequencies
    const counts: Record<string, number> = {};
    let validChars = 0;

    for (const seq of alignment) {
      const char = seq[i]?.toUpperCase();
      if (alphabet.includes(char)) {
        counts[char] = (counts[char] || 0) + 1;
        validChars++;
      }
    }

    if (validChars === 0) {
      columns.push({ position: i + 1, totalBits: 0, letters: [] });
      continue;
    }

    // 2. Calculate Entropy H(p)
    let entropy = 0;
    const freqs: Record<string, number> = {};

    for (const char of alphabet) {
      const count = counts[char] || 0;
      if (count > 0) {
        const p = count / validChars;
        freqs[char] = p;
        entropy -= p * Math.log2(p);
      }
    }

    // 3. Calculate Information Content R(p)
    // R(p) = max_bits - H(p) - e(n)
    let infoContent = maxBits - entropy - errorCorrection;
    infoContent = Math.max(0, infoContent); // Clamp to 0

    // 4. Calculate Letter Heights
    const letters = Object.entries(freqs)
      .map(([char, freq]) => ({
        char,
        height: freq * infoContent,
      }))
      .filter(l => l.height > 0.001) // Filter minimal contributions
      .sort((a, b) => a.height - b.height); // Sort ascending for stacking

    columns.push({
      position: i + 1,
      totalBits: infoContent,
      letters,
    });
  }

  return columns;
}
