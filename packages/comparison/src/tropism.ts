import type { PhageFull, GeneInfo } from '@phage-explorer/core';
import { translateSequence } from '@phage-explorer/core';

export interface ReceptorCandidate {
  receptor: string;
  confidence: number; // 0-1
  evidence: string[];
}

export interface TailFiberHit {
  gene: GeneInfo;
  aaLength?: number;
  motifs?: string[];
  receptorCandidates: ReceptorCandidate[];
}

export interface TropismAnalysis {
  phageId: number;
  phageName: string;
  hits: TailFiberHit[];
  breadth: 'narrow' | 'multi-receptor' | 'unknown';
  source: 'heuristic' | 'precomputed';
}

const fiberKeywords = [
  'tail fiber',
  'tail fibre',
  'tailspike',
  'tail spike',
  'receptor-binding protein',
  'receptor binding protein',
  'rbp',
  'baseplate wedge',
  'gp37',
  'gp38',
  'gp12',
  'fibritin',
];

const receptorPatterns: Array<{ receptor: string; patterns: string[] }> = [
  { receptor: 'LamB (maltoporin)', patterns: ['lamb', 'malb', 'maltoporin'] },
  { receptor: 'OmpC', patterns: ['ompc'] },
  { receptor: 'OmpA', patterns: ['ompa'] },
  { receptor: 'FhuA', patterns: ['fhua', 'fhu-a', 'tonb-dependent'] },
  { receptor: 'BtuB', patterns: ['btub', 'vitamin b12'] },
  { receptor: 'Tsx', patterns: ['tsx'] },
  { receptor: 'Flagellum', patterns: ['flagell', 'flagella', 'flagellar'] },
  { receptor: 'Type IV pilus', patterns: ['pilus', 'pili', 'pil ', 'pilA', 'pilB', 'pilC'] },
  { receptor: 'LPS / tailspike', patterns: ['tailspike', 'o-antigen', 'o antigen', 'lyase', 'polysaccharide', 'lps'] },
];

function containsAny(text: string, needles: string[]): boolean {
  return needles.some(n => text.includes(n));
}

function isTailFiberGene(gene: GeneInfo): boolean {
  const text = `${gene.name ?? ''} ${gene.product ?? ''}`.toLowerCase();
  return containsAny(text, fiberKeywords);
}

function reverseComplement(seq: string): string {
  const map: Record<string, string> = { A: 'T', T: 'A', C: 'G', G: 'C', N: 'N' };
  return seq
    .split('')
    .reverse()
    .map(c => map[c] ?? 'N')
    .join('');
}

function translateGeneSequence(genome: string, gene: GeneInfo): string {
  if (!genome) return '';
  const start = Math.max(0, gene.startPos); // stored as 0-based
  const end = Math.min(genome.length, gene.endPos);
  const raw = genome.slice(start, end);
  const dna = gene.strand === '-' ? reverseComplement(raw) : raw;
  return translateSequence(dna, 0);
}

function aminoAcidComposition(aa: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of aa) {
    counts[c] = (counts[c] ?? 0) + 1;
  }
  const total = aa.length || 1;
  for (const k of Object.keys(counts)) counts[k] /= total;
  return counts;
}

function motifHits(aa: string): string[] {
  const motifs: Array<{ id: string; re: RegExp }> = [
    { id: 'beta-helix (GGXGXD)', re: /GG.GD/i },
    { id: 'RGD integrin-like', re: /RGD/i },
    { id: 'collagen-like (GXT)n', re: /(G..){4,}/i },
    { id: 'pilus-binding (VQGDT)', re: /VQGDT/i },
    { id: 'porin-tip (SYG/ALG)', re: /(SYG|ALG)/i },
    { id: 'polysaccharide lyase (HXH)', re: /H.H/i },
  ];
  return motifs.filter(m => m.re.test(aa)).map(m => m.id);
}

function sequenceDrivenReceptors(aa: string): ReceptorCandidate[] {
  const hits = motifHits(aa);
  const comp = aminoAcidComposition(aa);
  const gly = comp['G'] ?? 0;
  const acidic = (comp['D'] ?? 0) + (comp['E'] ?? 0);
  const basic = (comp['K'] ?? 0) + (comp['R'] ?? 0);

  const candidates: ReceptorCandidate[] = [];

  // LPS / tailspike signatures: gly-rich, beta-helix motif
  if (gly > 0.12 || hits.includes('beta-helix (GGXGXD)')) {
    candidates.push({
      receptor: 'LPS / tailspike',
      confidence: clamp01(0.4 + gly * 1.5 + (hits.includes('beta-helix (GGXGXD)') ? 0.2 : 0)),
      evidence: [
        `gly=${gly.toFixed(2)}`,
        ...(hits.includes('beta-helix (GGXGXD)') ? ['beta-helix motif'] : []),
      ],
    });
  }

  // Porin tips: slightly acidic, SYG/ALG motifs
  if (hits.some(h => h.includes('porin-tip'))) {
    candidates.push({
      receptor: 'Porin (LamB/OmpC family)',
      confidence: clamp01(0.5 + acidic * 0.8),
      evidence: hits.filter(h => h.includes('porin-tip')),
    });
  }

  // Pilus binding
  if (hits.some(h => h.includes('pilus'))) {
    candidates.push({
      receptor: 'Type IV pilus',
      confidence: clamp01(0.55 + basic * 0.5),
      evidence: hits.filter(h => h.includes('pilus')),
    });
  }

  // Generic tail fiber if nothing else
  if (candidates.length === 0) {
    candidates.push({
      receptor: 'Unknown tail receptor',
      confidence: 0.25,
      evidence: ['no motif match'],
    });
  }

  return dedupeReceptors(candidates);
}

function annotationDrivenReceptors(productText: string): ReceptorCandidate[] {
  const results: ReceptorCandidate[] = [];
  for (const { receptor, patterns } of receptorPatterns) {
    const matches = patterns.filter(p => productText.includes(p));
    if (matches.length > 0) {
      const confidence = clamp01(0.55 + matches.length * 0.1);
      results.push({ receptor, confidence, evidence: matches });
    }
  }
  return results;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function analyzeTailFiberTropism(
  phage: PhageFull,
  genomeSequence = '',
  precomputed: TropismPredictionInput[] = []
): TropismAnalysis {
  const hits: TailFiberHit[] = [];

  // If precomputed predictions supplied, prefer them
  if (precomputed.length > 0) {
    const grouped = new Map<string, TailFiberHit>();
    for (const p of precomputed) {
      const key = p.locusTag ?? `gene-${p.geneId ?? 'unknown'}`;
      const existing = grouped.get(key) ?? {
        gene: {
          id: p.geneId ?? -1,
          name: p.locusTag ?? null,
          locusTag: p.locusTag ?? null,
          startPos: p.startPos ?? 0,
          endPos: p.endPos ?? 0,
          strand: p.strand ?? null,
          product: p.product ?? 'Tail fiber',
          type: 'CDS',
        },
        aaLength: p.aaLength,
        motifs: p.evidence?.filter(e => e.startsWith('motif:')).map(e => e.replace(/^motif:/, '')),
        receptorCandidates: [],
      };
      existing.receptorCandidates.push({
        receptor: p.receptor,
        confidence: p.confidence,
        evidence: p.evidence ?? [],
      });
      grouped.set(key, existing);
    }
    const receptors = new Set<string>();
    const mergedHits = Array.from(grouped.values()).map(h => ({
      ...h,
      receptorCandidates: dedupeReceptors(h.receptorCandidates),
    }));
    mergedHits.forEach(h => h.receptorCandidates.forEach(r => receptors.add(r.receptor)));
    const breadth: TropismAnalysis['breadth'] =
      receptors.size === 0 ? 'unknown' : receptors.size === 1 ? 'narrow' : 'multi-receptor';
    return {
      phageId: phage.id,
      phageName: phage.name,
      hits: mergedHits,
      breadth,
      source: 'precomputed',
    };
  }

  for (const gene of phage.genes ?? []) {
    if (!isTailFiberGene(gene)) continue;
    const text = `${gene.name ?? ''} ${gene.product ?? ''}`.toLowerCase();
    const aaSeq = genomeSequence ? translateGeneSequence(genomeSequence, gene) : '';
    const annotationReceptors = annotationDrivenReceptors(text);
    const sequenceReceptors = aaSeq ? sequenceDrivenReceptors(aaSeq) : [];
    const merged = dedupeReceptors([...annotationReceptors, ...sequenceReceptors]);
    hits.push({
      gene,
      aaLength: aaSeq.length || undefined,
      motifs: aaSeq ? motifHits(aaSeq) : undefined,
      receptorCandidates: merged,
    });
  }

  const receptors = new Set<string>();
  hits.forEach(h => h.receptorCandidates.forEach(rc => receptors.add(rc.receptor)));

  const breadth: TropismAnalysis['breadth'] =
    receptors.size === 0 ? 'unknown' : receptors.size === 1 ? 'narrow' : 'multi-receptor';

  return {
    phageId: phage.id,
    phageName: phage.name,
    hits,
    breadth,
    source: 'heuristic',
  };
}

export interface TropismPredictionInput {
  geneId: number | null;
  locusTag: string | null;
  receptor: string;
  confidence: number;
  evidence?: string[];
  startPos?: number;
  endPos?: number;
  strand?: string | null;
  product?: string | null;
  aaLength?: number;
}

function dedupeReceptors(candidates: ReceptorCandidate[]): ReceptorCandidate[] {
  const byName = new Map<string, ReceptorCandidate>();
  for (const c of candidates) {
    const existing = byName.get(c.receptor);
    if (!existing) {
      byName.set(c.receptor, c);
    } else {
      existing.confidence = Math.max(existing.confidence, c.confidence);
      existing.evidence = Array.from(new Set([...existing.evidence, ...c.evidence]));
    }
  }
  return Array.from(byName.values()).sort((a, b) => b.confidence - a.confidence);
}
