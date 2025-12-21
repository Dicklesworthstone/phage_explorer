import type { PhageFull, GeneInfo } from '@phage-explorer/core';
import { translateSequence, reverseComplement } from '@phage-explorer/core';

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
  // Outer membrane porins
  { receptor: 'LamB (maltoporin)', patterns: ['lamb', 'malb', 'maltoporin', 'maltose'] },
  { receptor: 'OmpC', patterns: ['ompc', 'outer membrane protein c'] },
  { receptor: 'OmpA', patterns: ['ompa', 'outer membrane protein a'] },
  { receptor: 'OmpF', patterns: ['ompf', 'outer membrane protein f'] },
  { receptor: 'FhuA', patterns: ['fhua', 'fhu-a', 'tonb-dependent', 'ferrichrome'] },
  { receptor: 'BtuB', patterns: ['btub', 'vitamin b12', 'cobalamin'] },
  { receptor: 'Tsx', patterns: ['tsx', 'nucleoside-specific'] },
  { receptor: 'FepA', patterns: ['fepa', 'enterobactin', 'ferric enterobactin'] },
  { receptor: 'TolC', patterns: ['tolc', 'outer membrane channel'] },
  // Appendages
  { receptor: 'Flagellum', patterns: ['flagell', 'flagella', 'flagellar', 'flic', 'flgk'] },
  { receptor: 'Type IV pilus', patterns: ['pilus', 'pili', 'pil ', 'pilA', 'pilB', 'pilC', 'type iv'] },
  { receptor: 'F-pilus (TraT)', patterns: ['trat', 'f-pilus', 'f pilus', 'conjugative'] },
  // Surface polysaccharides
  { receptor: 'LPS / O-antigen', patterns: ['tailspike', 'o-antigen', 'o antigen', 'lyase', 'polysaccharide', 'lps', 'lipopolysaccharide'] },
  { receptor: 'Capsular polysaccharide', patterns: ['capsul', 'k-antigen', 'k antigen', 'cps', 'kps'] },
  { receptor: 'Sialic acid', patterns: ['sialic', 'neuraminic', 'sialidase', 'neu5ac'] },
  { receptor: 'Teichoic acid (Gram+)', patterns: ['teichoic', 'wall teichoic', 'lipoteichoic'] },
  // Other surface structures
  { receptor: 'ManY (mannose PTS)', patterns: ['many', 'mannose', 'pts'] },
  { receptor: 'S-layer', patterns: ['s-layer', 's layer', 'surface layer'] },
];

function containsAny(text: string, needles: string[]): boolean {
  return needles.some(n => text.includes(n));
}

function isTailFiberGene(gene: GeneInfo): boolean {
  const text = `${gene.name ?? ''} ${gene.product ?? ''}`.toLowerCase();
  return containsAny(text, fiberKeywords);
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
    // Structural motifs
    { id: 'beta-helix (GGXGXD)', re: /GG.G.D/i },
    { id: 'beta-helix repeat', re: /([TV].{2}[DN]){3,}/i },
    { id: 'collagen-like (GXX)n', re: /(G..){5,}/i },
    { id: 'Ig-like domain', re: /[YF].{10,20}G.{5,15}[YF]/i },
    { id: 'fibronectin type III', re: /[WY].{20,40}[WY].{20,40}[WY]/i },
    // Binding motifs
    { id: 'RGD integrin-like', re: /RGD/i },
    { id: 'pilus-binding (VQGDT)', re: /VQGDT/i },
    { id: 'porin-tip (SYG/ALG)', re: /(SYG|ALG)/i },
    { id: 'polysaccharide lyase (HXH)', re: /H.H/i },
    { id: 'carbohydrate-binding', re: /(W.{4,8}W)|(QXW)/i },
    { id: 'lectin domain', re: /[DN].{20,40}[DN].{20,40}W/i },
    // Enzymatic motifs
    { id: 'endosialidase', re: /[DE].{40,80}H.{40,80}[DE]/i },
    { id: 'depolymerase', re: /(GXSXG)|(D.{50,100}E)/i },
    { id: 'lysozyme-like', re: /E.{5,15}D/i },
    // Repeat structures
    { id: 'tandem repeat', re: /(.{6,12})\1{2,}/i },
  ];
  return motifs.filter(m => m.re.test(aa)).map(m => m.id);
}

function sequenceDrivenReceptors(aa: string): ReceptorCandidate[] {
  const hits = motifHits(aa);
  const comp = aminoAcidComposition(aa);
  const gly = comp['G'] ?? 0;
  const trp = comp['W'] ?? 0;
  const acidic = (comp['D'] ?? 0) + (comp['E'] ?? 0);
  const basic = (comp['K'] ?? 0) + (comp['R'] ?? 0);
  const aromatic = (comp['W'] ?? 0) + (comp['Y'] ?? 0) + (comp['F'] ?? 0);
  const aaLen = aa.length;

  const candidates: ReceptorCandidate[] = [];

  // LPS / O-antigen tailspike: gly-rich, beta-helix motifs, often >500 aa
  const hasBetaHelix = hits.some(h => h.includes('beta-helix'));
  const hasDepolymerase = hits.some(h => h.includes('depolymerase'));
  if (gly > 0.10 || hasBetaHelix || hasDepolymerase) {
    const evidence: string[] = [];
    let conf = 0.35;
    if (gly > 0.10) { conf += gly * 1.2; evidence.push(`gly=${(gly * 100).toFixed(1)}%`); }
    if (hasBetaHelix) { conf += 0.2; evidence.push('beta-helix motif'); }
    if (hasDepolymerase) { conf += 0.15; evidence.push('depolymerase signature'); }
    if (aaLen > 500) { conf += 0.1; evidence.push(`long protein (${aaLen} aa)`); }
    candidates.push({
      receptor: 'LPS / O-antigen',
      confidence: clamp01(conf),
      evidence,
    });
  }

  // Capsular polysaccharide: similar to LPS but with endosialidase
  const hasEndosialidase = hits.some(h => h.includes('endosialidase'));
  if (hasEndosialidase) {
    candidates.push({
      receptor: 'Capsular polysaccharide',
      confidence: clamp01(0.65 + acidic * 0.3),
      evidence: ['endosialidase signature', `acidic=${(acidic * 100).toFixed(1)}%`],
    });
  }

  // Porin binding: SYG/ALG motifs, moderate acidic content
  if (hits.some(h => h.includes('porin-tip'))) {
    candidates.push({
      receptor: 'Porin (LamB/OmpC family)',
      confidence: clamp01(0.5 + acidic * 0.6),
      evidence: [...hits.filter(h => h.includes('porin-tip')), `acidic=${(acidic * 100).toFixed(1)}%`],
    });
  }

  // Type IV pilus binding: basic residues, pilus motif
  if (hits.some(h => h.includes('pilus'))) {
    candidates.push({
      receptor: 'Type IV pilus',
      confidence: clamp01(0.55 + basic * 0.4),
      evidence: [...hits.filter(h => h.includes('pilus')), `basic=${(basic * 100).toFixed(1)}%`],
    });
  }

  // Carbohydrate-binding (lectin-like): W-rich, carbohydrate/lectin motifs
  const hasCarb = hits.some(h => h.includes('carbohydrate') || h.includes('lectin'));
  if (hasCarb || trp > 0.04) {
    const evidence: string[] = [];
    let conf = 0.4;
    if (hasCarb) { conf += 0.25; evidence.push(...hits.filter(h => h.includes('carbohydrate') || h.includes('lectin'))); }
    if (trp > 0.04) { conf += 0.15; evidence.push(`trp=${(trp * 100).toFixed(1)}%`); }
    candidates.push({
      receptor: 'Carbohydrate receptor',
      confidence: clamp01(conf),
      evidence,
    });
  }

  // Ig-like / fibronectin domains suggest protein-protein interactions
  const hasIgLike = hits.some(h => h.includes('Ig-like') || h.includes('fibronectin'));
  if (hasIgLike) {
    candidates.push({
      receptor: 'Protein receptor (OMP)',
      confidence: clamp01(0.45 + aromatic * 0.5),
      evidence: [...hits.filter(h => h.includes('Ig-like') || h.includes('fibronectin')), `aromatic=${(aromatic * 100).toFixed(1)}%`],
    });
  }

  // Collagen-like repeats suggest host ECM or flagella binding
  const hasCollagen = hits.some(h => h.includes('collagen'));
  if (hasCollagen && gly > 0.15) {
    candidates.push({
      receptor: 'Flagellum / ECM',
      confidence: clamp01(0.4 + gly * 1.0),
      evidence: ['collagen-like repeats', `gly=${(gly * 100).toFixed(1)}%`],
    });
  }

  // Generic tail fiber if nothing else detected
  if (candidates.length === 0) {
    candidates.push({
      receptor: 'Unknown receptor',
      confidence: 0.2,
      evidence: hits.length > 0 ? hits : ['no clear receptor signature'],
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
