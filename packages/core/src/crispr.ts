import type { GeneInfo } from './types';
import { translateSequence, reverseComplement } from './codons';

export interface SpacerHit {
  position: number;
  sequence: string;
  host: string;
  crisprType: 'I' | 'II' | 'III' | 'V' | 'VI';
  matchScore: number; // 0-1
  pamStatus: 'valid' | 'invalid' | 'none';
  strand: 'coding' | 'template';
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
}

// Mock spacer database for demo purposes (in real app, this would be a DB query)
const MOCK_SPACERS = [
  'TGACGT', 'AACCGG', 'TTTGGG', 'CCCAAA', 'GGATCC', 'AAGCTT'
];

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
    const geneSeq = fullSequence.slice(gene.startPos - 1, gene.endPos);
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

      // Heuristic: Proximity to HTH motifs or specific domains (mocked here)
      if (length < 100) score += 20;

      // Random perturbation for demo variety if not strong signal
      if (score === 0) score = Math.floor(Math.random() * 30);

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

export function analyzeCRISPRPressure(sequence: string, genes: GeneInfo[]): CRISPRAnalysisResult {
  const spacerHits: SpacerHit[] = [];
  const windowSize = 500;
  const seqUpper = sequence.toUpperCase();
  
  // 1. Detect Spacer Hits (Mocked scanning against "known" spacers)
  // In a real implementation, we would search the sequence against a spacer DB.
  // Here we scan for our mock spacers to generate hits.
  MOCK_SPACERS.forEach((spacer) => {
    let pos = seqUpper.indexOf(spacer);
    while (pos !== -1) {
      // Check PAM context
      const upstream = pos >= 4 ? seqUpper.slice(pos - 4, pos) : '';
      const downstream = pos + spacer.length + 3 <= seqUpper.length ? seqUpper.slice(pos + spacer.length, pos + spacer.length + 3) : '';
      
      let type: 'I' | 'II' | 'V' = 'II';
      let pamStatus: 'valid' | 'invalid' = 'invalid';

      // Check Cas9 PAM (downstream NGG)
      if (downstream.endsWith('GG')) {
        type = 'II';
        pamStatus = 'valid';
      } 
      // Check Cas12a PAM (upstream TTTV)
      else if (upstream.startsWith('TTT')) {
        type = 'V';
        pamStatus = 'valid';
      }

      spacerHits.push({
        position: pos + 1,
        sequence: spacer,
        host: 'E. coli K-12', // Mock host
        crisprType: type,
        matchScore: 0.8 + (Math.random() * 0.2), // Randomize slightly
        pamStatus,
        strand: Math.random() > 0.5 ? 'coding' : 'template'
      });

      pos = seqUpper.indexOf(spacer, pos + 1);
    }
  });

  // Add some random noise hits for visual density if sequence is long
  if (sequence.length > 5000) {
    const numRandomHits = Math.floor(sequence.length / 2000);
    for (let i = 0; i < numRandomHits; i++) {
        spacerHits.push({
            position: Math.floor(Math.random() * sequence.length) + 1,
            sequence: 'RANDOM',
            host: 'S. enterica',
            crisprType: 'I',
            matchScore: 0.5 + Math.random() * 0.4,
            pamStatus: Math.random() > 0.7 ? 'valid' : 'invalid',
            strand: Math.random() > 0.5 ? 'coding' : 'template'
        });
    }
  }

  // 2. Predict Acr Candidates
  const acrCandidates = predictAcrCandidates(genes, seqUpper);

  // 3. Compute Pressure Windows
  const pressureWindows: CRISPRPressureWindow[] = [];
  let maxPressure = 0;

  for (let i = 0; i < sequence.length; i += windowSize) {
    const end = Math.min(i + windowSize, sequence.length);
    const pressure = calculatePressure(spacerHits, i + 1, end);
    const count = spacerHits.filter(h => h.position >= i + 1 && h.position < end).length;
    
    if (pressure > maxPressure) maxPressure = pressure;

    pressureWindows.push({
      start: i + 1,
      end,
      pressureIndex: pressure,
      spacerCount: count,
      dominantType: 'II' // Simplified
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
    maxPressure
  };
}
