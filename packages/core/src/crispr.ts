/**
 * CRISPR pressure analysis.
 *
 * ## The measurement that shaped this module
 *
 * This file used to scan the genome for six hardcoded 6-mers
 * (`TGACGT`, `AACCGG`, `TTTGGG`, `CCCAAA`, `GGATCC`, `AAGCTT`) and present the
 * results as spacer hits, with `host: 'E. coli K-12'` attached to every hit
 * regardless of the phage's real host, a `matchScore` derived from a string
 * hash, and a `dominantType` hardcoded to 'II'. A 6-mer recurs by chance about
 * every 4 kb, so a 48 kb genome produced dozens of "hits" that were pure
 * combinatorics, under a confident 0-10 pressure score, inside a workflow the
 * README recommends for phage-therapy candidate screening.
 *
 * Before replacing that with real data, the obvious question was measured
 * rather than assumed: do real spacers hit these genomes at all?
 *
 * CRISPRCasdb's spacer set (`spacer_34.zip`, `spacer_taxon.fsa`, 6,528 spacers
 * keyed by NCBI taxon id) was searched exhaustively against all 24 catalogue
 * genomes -- every spacer and its reverse complement, at every position, with
 * no seeding heuristic, so a zero is a real zero. Restricted to the spacers
 * whose taxon matches each phage's actual host:
 *
 *     exact matches          0
 *     within 2 mismatches    0
 *     within 5 mismatches    1   (phage P1, 4 mismatches in 32 bp)
 *
 * Best-case similarity elsewhere was 28-31 mismatches out of ~32, which is no
 * similarity at all. The single P1 hit at 4/32 in a 94 kb genome is what chance
 * produces.
 *
 * That is a real negative result and it decides the design. These are classic
 * laboratory phages; the sequenced strains behind CRISPRCasdb have largely not
 * been challenged by them, and E. coli K-12's CRISPR system is famously
 * inactive. Five of the eleven hosts have no spacers on record at all
 * (Bacillus subtilis, Pseudomonas syringae, Mycobacterium smegmatis,
 * Pseudoalteromonas espejiana, and Streptomyces coelicolor has exactly one).
 *
 * So there is no honest spacer-hit result to show for this catalogue, and the
 * module reports that rather than manufacturing one. `analyzeCRISPRPressure`
 * takes the spacers to search as an argument and returns zero hits when given
 * none, with `noSpacerDataFor` naming the host so the UI can say which data is
 * missing. Widening the mock k-mers was never an option: a longer fabricated
 * spacer is still fabricated.
 *
 * Reproduce the measurement with the harness described in
 * phage_explorer-uhx4.1.
 */

import type { GeneInfo } from './types';
import { translateSequence, reverseComplement } from './codons';

/** One real CRISPR spacer, with enough provenance for a user to look it up. */
export interface SpacerRecord {
  /** Spacer sequence as recorded, 5'->3'. */
  sequence: string;
  /** Organism whose CRISPR array carried it. Never a constant. */
  host: string;
  /** Subtype, where the source records one. */
  crisprType?: 'I' | 'II' | 'III' | 'V' | 'VI';
  /** Source accession, so a hit can be traced back. */
  accession?: string;
}

export interface SpacerHit {
  position: number;
  sequence: string;
  /** The host whose array carried the matching spacer. From the spacer record. */
  host: string;
  crisprType: 'I' | 'II' | 'III' | 'V' | 'VI';
  /**
   * Match quality in [0,1], computed as 1 - mismatches/length. A real quantity
   * from the alignment; it used to be `0.8 + hash(...) * 0.2`.
   */
  matchScore: number;
  /** Mismatches between spacer and protospacer at this position. */
  mismatches: number;
  pamStatus: 'valid' | 'invalid' | 'none';
  /** Which strand the protospacer sits on. From the alignment, not a hash. */
  strand: 'coding' | 'template';
  /** Source accession of the spacer, when the record carries one. */
  accession?: string;
}

export interface AcrCandidate {
  geneId: number;
  geneName: string | null;
  score: number; // 0-100
  family: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface CRISPRPressureWindow {
  start: number;
  end: number;
  pressureIndex: number; // 0-10 scale
  spacerCount: number;
  dominantType: string;
}

export interface CRISPRAnalysisResult {
  spacerHits: SpacerHit[];
  acrCandidates: AcrCandidate[];
  pressureWindows: CRISPRPressureWindow[];
  maxPressure: number;
  /**
   * How many spacers were actually searched. Zero means this result makes no
   * claim about CRISPR pressure, and a UI must say so rather than render a
   * pressure of 0 as if it were measured.
   */
  spacersSearched: number;
  /**
   * The host for which no spacer data was available, or null when spacers were
   * searched. Lets the UI name what is missing instead of showing an empty
   * chart that looks like a negative finding.
   */
  noSpacerDataFor: string | null;
}

export interface CRISPRAnalysisOptions {
  /**
   * Real spacers to search, for this phage's host. Omitted or empty means no
   * spacer data is available, which is the honest state for every phage in the
   * shipped catalogue -- see the measurement in this file's header.
   */
  spacers?: SpacerRecord[];
  /** The phage's real host, used to say what data is missing. */
  host?: string;
  /**
   * Mismatches tolerated between spacer and protospacer. Five is the usual
   * threshold in the literature for a 32 bp spacer; zero would miss real,
   * diverged protospacers.
   */
  maxMismatches?: number;
}

// MOCK_SPACERS lived here: six 6-mers scanned with indexOf and reported as
// spacer hits. Deleted rather than lengthened -- a longer fabricated spacer is
// still fabricated. hashString and seededUnit went with it; they existed only
// to give the fake hits a plausible-looking matchScore and strand.
//
// Real spacers now arrive through CRISPRAnalysisOptions.spacers.

/** Minimum spacer length worth searching. Below this, chance matches dominate. */
const MIN_SPACER_LENGTH = 20;

function calculatePressure(hits: SpacerHit[], windowStart: number, windowEnd: number): number {
  const hitsInWindow = hits.filter(h => h.position >= windowStart && h.position < windowEnd);
  if (hitsInWindow.length === 0) return 0;
  
  return hitsInWindow.reduce((acc, hit) => {
    let score = hit.matchScore;
    if (hit.pamStatus === 'valid') score *= 1.5;
    if (hit.strand === 'coding') score *= 1.2;
    return acc + score;
  }, 0);
}

// Heuristic to predict Acr candidates based on size and acidity
function predictAcrCandidates(genes: GeneInfo[], fullSequence: string): AcrCandidate[] {
  const candidates: AcrCandidate[] = [];

  for (const gene of genes) {
    const geneSeq = fullSequence.slice(gene.startPos, gene.endPos);
    const seqForTranslation = gene.strand === '-' ? reverseComplement(geneSeq) : geneSeq;
    const protein = translateSequence(seqForTranslation);
    const length = protein.length;

    // Acr proteins are typically small (50-200 aa)
    if (length >= 50 && length <= 200) {
      // Calculate acidity (approximate DNA mimicry)
      const acidic = (protein.match(/[DE]/g) || []).length;
      const basic = (protein.match(/[KR]/g) || []).length;
      const netCharge = basic - acidic;

      let score = 0;
      let family = 'Unknown';

      // Heuristic: Net negative charge (DNA mimic) is common for Acrs
      if (netCharge < -5) {
        score += 40;
        family = 'DNA-Mimic';
      }

      // Heuristic: small proteins are over-represented among known Acrs.
      if (length < 100) score += 20;

      // A "Random perturbation for demo variety" used to run here, assigning a
      // hash-derived score of 0-30 to any gene the heuristics scored at zero.
      // Genes that match no criterion score zero and are not candidates; that
      // is the correct output, and inventing variety to make the list look
      // fuller is how a screening tool starts lying.

      if (score > 30) {
        candidates.push({
          geneId: gene.id,
          geneName: gene.name || gene.locusTag || 'hypothetical',
          score,
          family,
          confidence: score > 60 ? 'high' : score > 45 ? 'medium' : 'low'
        });
      }
    }
  }
  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Find protospacers: positions where a real spacer matches within the mismatch
 * budget, on either strand.
 *
 * Exhaustive rather than seeded. A seed heuristic would make a reported zero
 * ambiguous between "no hit" and "the screen missed it", and the whole point of
 * this module now is that zero means zero.
 */
function findProtospacers(
  seqUpper: string,
  spacers: SpacerRecord[],
  maxMismatches: number
): SpacerHit[] {
  const hits: SpacerHit[] = [];

  for (const record of spacers) {
    const spacer = record.sequence.toUpperCase();
    if (spacer.length < MIN_SPACER_LENGTH) continue;

    const orientations: Array<{ pattern: string; strand: 'coding' | 'template' }> = [
      { pattern: spacer, strand: 'coding' },
      { pattern: reverseComplement(spacer), strand: 'template' },
    ];

    for (const { pattern, strand } of orientations) {
      const m = pattern.length;
      for (let i = 0; i + m <= seqUpper.length; i++) {
        let mismatches = 0;
        for (let j = 0; j < m; j++) {
          if (seqUpper[i + j] !== pattern[j]) {
            mismatches++;
            if (mismatches > maxMismatches) break;
          }
        }
        if (mismatches > maxMismatches) continue;

        // PAM context. Cas9 reads NGG immediately 3' of the protospacer;
        // Cas12a reads TTTV immediately 5'. Absence of both is 'none', not
        // 'invalid': we checked two systems, not every system.
        const upstream = i >= 4 ? seqUpper.slice(i - 4, i) : '';
        const downstream = seqUpper.slice(i + m, i + m + 3);

        let type: SpacerHit['crisprType'] = record.crisprType ?? 'II';
        let pamStatus: SpacerHit['pamStatus'] = 'none';
        if (downstream.length === 3 && downstream.endsWith('GG')) {
          if (!record.crisprType) type = 'II';
          pamStatus = 'valid';
        } else if (upstream.startsWith('TTT')) {
          if (!record.crisprType) type = 'V';
          pamStatus = 'valid';
        }

        hits.push({
          position: i,
          sequence: seqUpper.slice(i, i + m),
          host: record.host,
          crisprType: type,
          matchScore: 1 - mismatches / m,
          mismatches,
          pamStatus,
          strand,
          accession: record.accession,
        });
      }
    }
  }

  return hits;
}

/**
 * Analyse CRISPR pressure on a phage genome.
 *
 * With no spacers supplied, returns zero hits and a zero pressure profile, and
 * sets `noSpacerDataFor` so the caller can say WHICH host's data is missing.
 * That is the state for every phage in the shipped catalogue; see the
 * measurement in this file's header for why.
 */
export function analyzeCRISPRPressure(
  sequence: string,
  genes: GeneInfo[],
  options: CRISPRAnalysisOptions = {}
): CRISPRAnalysisResult {
  const { spacers = [], host, maxMismatches = 5 } = options;
  const windowSize = 500;
  const seqUpper = sequence.toUpperCase();

  const usable = spacers.filter(sp => sp.sequence.length >= MIN_SPACER_LENGTH);
  const spacerHits = usable.length > 0
    ? findProtospacers(seqUpper, usable, maxMismatches)
    : [];

  // 2. Predict Acr candidates. Independent of spacer data: this is a heuristic
  // over the phage's own genes and stands or falls on its own.
  const acrCandidates = predictAcrCandidates(genes, seqUpper);

  // 3. Compute pressure windows
  const pressureWindows: CRISPRPressureWindow[] = [];
  let maxPressure = 0;

  for (let i = 0; i < sequence.length; i += windowSize) {
    const end = Math.min(i + windowSize, sequence.length);
    const pressure = calculatePressure(spacerHits, i, end);
    const inWindow = spacerHits.filter(h => h.position >= i && h.position < end);

    if (pressure > maxPressure) maxPressure = pressure;

    // Dominant type is counted from the hits in this window, not hardcoded.
    // It used to be the literal 'II' with the comment "Simplified", which
    // reported a Cas9 system for every window of every genome.
    const typeCounts = new Map<string, number>();
    for (const h of inWindow) typeCounts.set(h.crisprType, (typeCounts.get(h.crisprType) ?? 0) + 1);
    let dominantType = 'none';
    let bestCount = 0;
    for (const [t, c] of typeCounts) {
      if (c > bestCount) { bestCount = c; dominantType = t; }
    }

    pressureWindows.push({
      start: i,
      end,
      pressureIndex: pressure,
      spacerCount: inWindow.length,
      dominantType,
    });
  }

  // Normalize pressure to 0-10
  if (maxPressure > 0) {
    pressureWindows.forEach(w => {
      w.pressureIndex = (w.pressureIndex / maxPressure) * 10;
    });
  }

  return {
    spacerHits: spacerHits.sort((a, b) => a.position - b.position),
    acrCandidates,
    pressureWindows,
    maxPressure,
    spacersSearched: usable.length,
    noSpacerDataFor: usable.length === 0 ? (host ?? 'this phage\'s host') : null,
  };
}
