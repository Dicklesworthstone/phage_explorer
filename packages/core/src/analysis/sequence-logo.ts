/**
 * Information-theoretic Sequence Logo Analysis
 *
 * Calculates Shannon entropy and information content (bits) for a multiple sequence alignment.
 * Supports DNA (2 bits max) and Protein (4.3 bits max).
 */

import { getGeneticCode, isSupportedGeneticCode, reverseComplement } from '../codons';
import { getGeneMapSegments, parseLocalFeatureLocation } from '../genome-import';
import type { GeneInfo } from '../types';

export const GENE_START_LOGO_WINDOW = { upstream: 20, downstream: 10 } as const;
export type GeneStartLogoExclusion = 'partial-start' | 'unsupported-annotation' | 'invalid-location' |
  'unsupported-code' | 'unresolved-start' | 'unsupported-initiator' | 'split-initiator' | 'genome-edge' | 'duplicate-start';
export const GENE_START_LOGO_EXCLUSION_LABELS: Record<GeneStartLogoExclusion, string> = {
  'partial-start': 'Partial or unsupported codon_start; initiation site is unavailable',
  'unsupported-annotation': 'Pseudogene, partial, recoding or other unsupported CDS qualifier',
  'invalid-location': 'Uncertain, inconsistent, overlapping or out-of-bounds CDS location',
  'unsupported-code': 'Unsupported translation table',
  'unresolved-start': 'Fewer than three resolved bases at the annotated start',
  'unsupported-initiator': 'Annotated start triplet is not an initiator in its genetic code',
  'split-initiator': 'Initiation codon crosses a noncontiguous genomic junction',
  'genome-edge': 'Complete genomic window unavailable without assuming circular topology',
  'duplicate-start': 'This oriented genomic start is already represented',
};
export interface GeneStartLogoAlignment {
  totalCds: number;
  topology: 'linear' | 'circular' | 'unknown';
  windows: Array<{
    geneId: number; name: string; anchor: number; strand: '+' | '-';
    geneticCode: number; startCodon: string; sequence: string; wrapped: boolean;
  }>;
  excluded: Array<{ geneId: number; name: string; reason: GeneStartLogoExclusion }>;
}

/** Fixed genomic context around distinct, exact annotated initiation sites.
 * _segments is in transcript order, including complement(join(...)) and origin
 * crossings. Never reconstruct that order from a bounding box or a locus tag.
 * INSDC defines codon_start as the first COMPLETE codon's offset; only 1 can
 * describe a complete amino terminus. A partial CDS is not an initiation motif.
 * https://www.insdc.org/submitting-standards/feature-table/ (/codon_start)
 */
export function buildGeneStartAlignment(genome: string, genes: readonly GeneInfo[],
  topology: GeneStartLogoAlignment['topology'] = 'unknown'): GeneStartLogoAlignment {
  if (!['linear', 'circular', 'unknown'].includes(topology)) throw new Error('Unsupported genome topology.');
  const sequence = genome.toUpperCase(), length = sequence.length;
  if (/[^ACGTRYSWKMBDHVN]/.test(sequence)) throw new Error('Gene-start logos require IUPAC DNA with original genomic positions.');
  const result: GeneStartLogoAlignment = { totalCds: 0, topology, windows: [], excluded: [] };
  const starts = new Set<string>();
  const { upstream, downstream } = GENE_START_LOGO_WINDOW;

  for (const gene of genes) {
    if ((gene.type ?? '').toUpperCase() !== 'CDS') continue;
    result.totalCds++;
    const name = gene.locusTag || gene.name || `CDS ${gene.id}`;
    const exclude = (reason: GeneStartLogoExclusion): void => { result.excluded.push({ geneId: gene.id, name, reason }); };
    const q = gene.qualifiers ?? {};
    const codonStart = q.codon_start === undefined ? 1 : q.codon_start;
    if (codonStart !== 1 && (typeof codonStart !== 'string' || codonStart.trim() !== '1')) { exclude('partial-start'); continue; }
    if (['pseudo', 'pseudogene', 'partial', 'exception', 'transl_except', 'ribosomal_slippage', 'trans_splicing', 'artificial_location']
      .some(key => Object.hasOwn(q, key))) { exclude('unsupported-annotation'); continue; }
    const table = q.transl_table === undefined ? 1 : q.transl_table;
    const code = typeof table === 'number' || typeof table === 'string' && /^\d+$/.test(table.trim()) ? Number(table) : 0;
    if (!isSupportedGeneticCode(code)) { exclude('unsupported-code'); continue; }
    const parts = getGeneMapSegments(gene), sorted = [...parts].sort((a, b) => a.start - b.start);
    let validLocation = Number.isSafeInteger(gene.startPos) && Number.isSafeInteger(gene.endPos)
      && gene.startPos >= 0 && gene.startPos < gene.endPos && gene.endPos <= length
      && (gene.strand === '+' || gene.strand === '-') && parts.length > 0
      && (!Object.hasOwn(q, '_segments') || Array.isArray(q._segments) && q._segments.length === parts.length)
      && parts.every(part => Number.isSafeInteger(part.start) && Number.isSafeInteger(part.end)
        && part.start >= 0 && part.start < part.end && part.end <= length && part.strand === gene.strand)
      && sorted.every((part, i) => i === 0 || part.start >= sorted[i - 1].end)
      && sorted[0]?.start === gene.startPos && sorted[sorted.length - 1]?.end === gene.endPos;
    if (Object.hasOwn(q, '_location')) {
      try {
        if (typeof q._location !== 'string') throw new Error('Invalid location');
        const declared = parseLocalFeatureLocation(q._location, length);
        validLocation = validLocation && declared.length === parts.length && declared.every((part, i) =>
          part.start === parts[i].start && part.end === parts[i].end && part.strand === parts[i].strand);
      } catch { validLocation = false; }
    }
    if (!validLocation) { exclude('invalid-location'); continue; }

    const strand = gene.strand as '+' | '-', direction = strand === '+' ? 1 : -1;
    const anchor = strand === '+' ? parts[0].start : parts[0].end - 1;
    const firstPositions: number[] = [];
    for (const part of parts) {
      for (let i = 0; i < part.end - part.start && firstPositions.length < 3; i++) {
        firstPositions.push(strand === '+' ? part.start + i : part.end - 1 - i);
      }
      if (firstPositions.length === 3) break;
    }
    const startCodon = firstPositions.map(position => strand === '+' ? sequence[position] : reverseComplement(sequence[position])).join('');
    if (startCodon.length !== 3 || /[^ACGT]/.test(startCodon)) { exclude('unresolved-start'); continue; }
    if (!getGeneticCode(code).starts.includes(startCodon)) { exclude('unsupported-initiator'); continue; }
    // The display is genomic context, not a spliced transcript. An initiator
    // split by an intron cannot be drawn as three consecutive genomic bases.
    if (firstPositions.some((position, i) => {
      const expected = anchor + direction * i;
      return position !== (topology === 'circular' ? (expected + length) % length : expected);
    })) { exclude('split-initiator'); continue; }
    const low = strand === '+' ? anchor - upstream : anchor - downstream + 1;
    const high = strand === '+' ? anchor + downstream : anchor + upstream + 1;
    const wrapped = low < 0 || high > length;
    // Repeating a short circular record would count the same physical base
    // more than once inside a single window.
    if (length < upstream + downstream || wrapped && topology !== 'circular') { exclude('genome-edge'); continue; }
    const key = `${strand}:${anchor}`;
    if (starts.has(key)) { exclude('duplicate-start'); continue; }
    starts.add(key);
    let window = '';
    for (let offset = -upstream; offset < downstream; offset++) {
      const position = (anchor + direction * offset + length) % length;
      window += strand === '+' ? sequence[position] : reverseComplement(sequence[position]);
    }
    result.windows.push({ geneId: gene.id, name, anchor, strand, geneticCode: code, startCodon, sequence: window, wrapped });
  }
  return result;
}

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

  const seqLength = alignment[0].length;
  const alphabet = type === 'dna' ? DNA_ALPHABET : PROTEIN_ALPHABET;
  const maxBits = Math.log2(alphabet.length);

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
    // Use validChars for n to account for gaps reducing sample size
    const errorCorrection = calculateErrorCorrection(validChars, alphabet.length);
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
