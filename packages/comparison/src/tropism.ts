import type { PhageFull, GeneInfo } from '@phage-explorer/core';

export interface ReceptorCandidate {
  receptor: string;
  confidence: number; // 0-1
  evidence: string[];
}

export interface TailFiberHit {
  gene: GeneInfo;
  receptorCandidates: ReceptorCandidate[];
}

export interface TropismAnalysis {
  phageId: number;
  phageName: string;
  hits: TailFiberHit[];
  breadth: 'narrow' | 'multi-receptor' | 'unknown';
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

function findReceptors(productText: string): ReceptorCandidate[] {
  const results: ReceptorCandidate[] = [];
  for (const { receptor, patterns } of receptorPatterns) {
    const matches = patterns.filter(p => productText.includes(p));
    if (matches.length > 0) {
      const confidence = Math.min(1, 0.5 + matches.length * 0.1);
      results.push({ receptor, confidence, evidence: matches });
    }
  }
  return results;
}

function isTailFiberGene(gene: GeneInfo): boolean {
  const text = `${gene.name ?? ''} ${gene.product ?? ''}`.toLowerCase();
  return containsAny(text, fiberKeywords);
}

export function analyzeTailFiberTropism(phage: PhageFull): TropismAnalysis {
  const hits: TailFiberHit[] = [];

  for (const gene of phage.genes ?? []) {
    if (!isTailFiberGene(gene)) continue;
    const text = `${gene.name ?? ''} ${gene.product ?? ''}`.toLowerCase();
    const receptorCandidates = findReceptors(text);
    const unique = dedupeReceptors(receptorCandidates);
    hits.push({ gene, receptorCandidates: unique });
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
  };
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
