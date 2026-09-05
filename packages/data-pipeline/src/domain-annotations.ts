/**
 * Domain-Derived Annotations Pipeline
 *
 * Re-derives defense system and Auxiliary Metabolic Gene (AMG) annotations
 * from Pfam protein domains rather than product name heuristics.
 */

import type { Database } from 'bun:sqlite';

export interface DomainDefenseRule {
  domainId: string;
  systemType: string;
  systemFamily: string;
  targetSystem: string;
  mechanism: string;
  confidence: number;
}

export interface DomainAmgRule {
  domainId: string;
  amgType: string;
  keggOrtholog: string;
  pathwayName: string;
  confidence: number;
}

export const PFAM_DEFENSE_RULES: DomainDefenseRule[] = [
  {
    domainId: 'PF08684',
    systemType: 'anti-RM',
    systemFamily: 'Ocr',
    targetSystem: 'Type I restriction-modification',
    mechanism: 'DNA mimicry inhibiting host Type I restriction endonuclease cleavage',
    confidence: 0.98,
  },
  {
    domainId: 'PF11058',
    systemType: 'anti-RM',
    systemFamily: 'Ral',
    targetSystem: 'Type I restriction-modification',
    mechanism: 'Antirestriction protein relieving Type I restriction endonuclease cleavage',
    confidence: 0.95,
  },
  {
    domainId: 'PF11043',
    systemType: 'anti-exonuclease',
    systemFamily: 'Abc2',
    targetSystem: 'Host RecBCD exonuclease',
    mechanism: 'Inhibits host RecBCD exonuclease V DNA degradation',
    confidence: 0.95,
  },
  {
    domainId: 'PF02086',
    systemType: 'anti-RM',
    systemFamily: 'D12-methylase',
    targetSystem: 'Type II/III restriction-modification',
    mechanism: 'Adenine DNA methylation conferring immunity to host restriction endonuclease',
    confidence: 0.90,
  },
  {
    domainId: 'PF00145',
    systemType: 'anti-RM',
    systemFamily: 'C5-methylase',
    targetSystem: 'Type II restriction-modification',
    mechanism: 'Cytosine DNA methylation protecting phage genome against host restriction',
    confidence: 0.90,
  },
  {
    domainId: 'PF14072',
    systemType: 'anti-RM',
    systemFamily: 'DndB',
    targetSystem: 'Phosphorothioation / Restriction',
    mechanism: 'Phosphorothioate DNA modification protecting against restriction cleavage',
    confidence: 0.88,
  },
  {
    domainId: 'PF04851',
    systemType: 'anti-RM',
    systemFamily: 'ResIII',
    targetSystem: 'Type III restriction-modification',
    mechanism: 'Phage-encoded restriction-modification endonuclease/methylase subunit',
    confidence: 0.85,
  },
];

export const PFAM_AMG_RULES: DomainAmgRule[] = [
  // Photosynthesis
  { domainId: 'PF00124', amgType: 'photosynthesis', keggOrtholog: 'K02703', pathwayName: 'Photosynthesis', confidence: 0.98 },
  { domainId: 'PF00554', amgType: 'photosynthesis', keggOrtholog: 'K02706', pathwayName: 'Photosynthesis', confidence: 0.98 },
  // Phosphorus metabolism
  { domainId: 'PF00148', amgType: 'phosphorus-metabolism', keggOrtholog: 'K06217', pathwayName: 'Phosphonate and phosphinate metabolism', confidence: 0.90 },
  // Sulfur metabolism
  { domainId: 'PF01507', amgType: 'sulfur-metabolism', keggOrtholog: 'K00390', pathwayName: 'Sulfur metabolism', confidence: 0.92 },
  // Folate biosynthesis
  { domainId: 'PF00186', amgType: 'folate-biosynthesis', keggOrtholog: 'K00287', pathwayName: 'Folate biosynthesis', confidence: 0.95 },
  // Nucleotide metabolism
  { domainId: 'PF00303', amgType: 'nucleotide-metabolism', keggOrtholog: 'K00560', pathwayName: 'Pyrimidine metabolism', confidence: 0.95 },
  { domainId: 'PF02511', amgType: 'nucleotide-metabolism', keggOrtholog: 'K06877', pathwayName: 'Pyrimidine metabolism', confidence: 0.92 },
  { domainId: 'PF02867', amgType: 'nucleotide-metabolism', keggOrtholog: 'K00525', pathwayName: 'Purine and pyrimidine metabolism', confidence: 0.95 },
  { domainId: 'PF00317', amgType: 'nucleotide-metabolism', keggOrtholog: 'K00525', pathwayName: 'Purine and pyrimidine metabolism', confidence: 0.95 },
  { domainId: 'PF08343', amgType: 'nucleotide-metabolism', keggOrtholog: 'K00525', pathwayName: 'Purine and pyrimidine metabolism', confidence: 0.95 },
  { domainId: 'PF17975', amgType: 'nucleotide-metabolism', keggOrtholog: 'K00525', pathwayName: 'Purine and pyrimidine metabolism', confidence: 0.95 },
  { domainId: 'PF21995', amgType: 'nucleotide-metabolism', keggOrtholog: 'K00525', pathwayName: 'Purine and pyrimidine metabolism', confidence: 0.90 },
  { domainId: 'PF00268', amgType: 'nucleotide-metabolism', keggOrtholog: 'K00526', pathwayName: 'Purine and pyrimidine metabolism', confidence: 0.95 },
  { domainId: 'PF13597', amgType: 'nucleotide-metabolism', keggOrtholog: 'K00527', pathwayName: 'Purine and pyrimidine metabolism', confidence: 0.95 },
  { domainId: 'PF00692', amgType: 'nucleotide-metabolism', keggOrtholog: 'K01520', pathwayName: 'Pyrimidine metabolism', confidence: 0.95 },
  { domainId: 'PF00364', amgType: 'nucleotide-metabolism', keggOrtholog: 'K02428', pathwayName: 'Purine metabolism', confidence: 0.90 },
  { domainId: 'PF21448', amgType: 'nucleotide-metabolism', keggOrtholog: 'K00542', pathwayName: 'Pyrimidine metabolism', confidence: 0.92 },
  { domainId: 'PF22769', amgType: 'nucleotide-metabolism', keggOrtholog: 'K01494', pathwayName: 'Pyrimidine metabolism', confidence: 0.90 },
  { domainId: 'PF00383', amgType: 'nucleotide-metabolism', keggOrtholog: 'K01493', pathwayName: 'Pyrimidine metabolism', confidence: 0.90 },
  { domainId: 'PF01712', amgType: 'nucleotide-metabolism', keggOrtholog: 'K00543', pathwayName: 'Purine and pyrimidine metabolism', confidence: 0.92 },
  { domainId: 'PF02223', amgType: 'nucleotide-metabolism', keggOrtholog: 'K00544', pathwayName: 'Pyrimidine metabolism', confidence: 0.95 },
  { domainId: 'PF00265', amgType: 'nucleotide-metabolism', keggOrtholog: 'K00857', pathwayName: 'Pyrimidine metabolism', confidence: 0.95 },
];

export interface DerivedDefenseHit {
  phageId: number;
  geneId: number;
  locusTag: string | null;
  systemType: string;
  systemFamily: string | null;
  targetSystem: string;
  mechanism: string;
  confidence: number;
  source: string;
}

export interface DerivedAmgHit {
  phageId: number;
  geneId: number;
  locusTag: string | null;
  amgType: string;
  keggOrtholog: string | null;
  keggReaction: string | null;
  keggPathway: string | null;
  pathwayName: string;
  confidence: number;
  evidence: string;
}

export function detectDomainDefenseSystems(
  db: Database,
  rules: DomainDefenseRule[] = PFAM_DEFENSE_RULES
): DerivedDefenseHit[] {
  const hits: DerivedDefenseHit[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    const rows = db.query<
      {
        phage_id: number;
        gene_id: number;
        locus_tag: string | null;
        domain_id: string;
        domain_name: string | null;
        description: string | null;
        e_value: number | null;
      },
      [string]
    >(`
      SELECT phage_id, gene_id, locus_tag, domain_id, domain_name, description, e_value
      FROM protein_domains
      WHERE domain_id = ?
      ORDER BY phage_id, gene_id
    `).all(rule.domainId);

    for (const row of rows) {
      const key = `${row.phage_id}:${row.gene_id}:${rule.systemType}`;
      if (seen.has(key)) continue;
      seen.add(key);

      hits.push({
        phageId: row.phage_id,
        geneId: row.gene_id,
        locusTag: row.locus_tag,
        systemType: rule.systemType,
        systemFamily: rule.systemFamily,
        targetSystem: rule.targetSystem,
        mechanism: `${rule.mechanism} [Pfam: ${row.domain_id} (${row.domain_name ?? ''})]`,
        confidence: rule.confidence,
        source: 'pfam-domain',
      });
    }
  }

  return hits;
}

export function detectDomainAmgs(
  db: Database,
  rules: DomainAmgRule[] = PFAM_AMG_RULES
): DerivedAmgHit[] {
  const hits: DerivedAmgHit[] = [];
  const seen = new Set<string>();

  for (const rule of rules) {
    const rows = db.query<
      {
        phage_id: number;
        gene_id: number;
        locus_tag: string | null;
        domain_id: string;
        domain_name: string | null;
        description: string | null;
        e_value: number | null;
        score: number | null;
      },
      [string]
    >(`
      SELECT phage_id, gene_id, locus_tag, domain_id, domain_name, description, e_value, score
      FROM protein_domains
      WHERE domain_id = ?
      ORDER BY phage_id, gene_id
    `).all(rule.domainId);

    for (const row of rows) {
      const key = `${row.phage_id}:${row.gene_id}:${rule.keggOrtholog}`;
      if (seen.has(key)) continue;
      seen.add(key);

      hits.push({
        phageId: row.phage_id,
        geneId: row.gene_id,
        locusTag: row.locus_tag,
        amgType: rule.amgType,
        keggOrtholog: rule.keggOrtholog,
        keggReaction: null,
        keggPathway: null,
        pathwayName: rule.pathwayName,
        confidence: rule.confidence,
        evidence: JSON.stringify({
          source: 'pfam-domain',
          domainId: row.domain_id,
          domainName: row.domain_name,
          eValue: row.e_value,
          score: row.score,
        }),
      });
    }
  }

  return hits;
}

export function updateDomainAnnotations(
  db: Database
): { defenseCount: number; defensePhages: number; amgCount: number; amgPhages: number } {
  // 1. Derive domain defense systems
  const domainDefenseHits = detectDomainDefenseSystems(db);

  // Remove old non-esm2 defense rows (so we keep esm2-nn anti-CRISPR hits while updating domain-derived ones)
  db.run(`DELETE FROM defense_systems WHERE source != 'esm2-nn'`);

  const insertDefense = db.prepare(`
    INSERT INTO defense_systems (phage_id, gene_id, locus_tag, system_type, system_family, target_system, mechanism, confidence, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const h of domainDefenseHits) {
    insertDefense.run(
      h.phageId,
      h.geneId,
      h.locusTag,
      h.systemType,
      h.systemFamily,
      h.targetSystem,
      h.mechanism,
      h.confidence,
      h.source
    );
  }

  // 2. Derive domain AMGs
  const domainAmgHits = detectDomainAmgs(db);

  // Replace old amg_annotations with domain-derived AMGs
  db.run(`DELETE FROM amg_annotations`);

  const insertAmg = db.prepare(`
    INSERT INTO amg_annotations (phage_id, gene_id, locus_tag, amg_type, kegg_ortholog, kegg_reaction, kegg_pathway, pathway_name, confidence, evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const a of domainAmgHits) {
    insertAmg.run(
      a.phageId,
      a.geneId,
      a.locusTag,
      a.amgType,
      a.keggOrtholog,
      a.keggReaction,
      a.keggPathway,
      a.pathwayName,
      a.confidence,
      a.evidence
    );
  }

  return refreshDomainAnnotationMetadata(db);
}

/** Refresh coverage from the stored annotations without rerunning or replacing calls. */
export function refreshDomainAnnotationMetadata(
  db: Database
): { defenseCount: number; defensePhages: number; amgCount: number; amgPhages: number } {
  db.run(`
    CREATE TABLE IF NOT EXISTS annotation_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  const defenseStats = db.query<{ count: number; phages: number }, []>(
    `SELECT COUNT(*) as count, COUNT(DISTINCT phage_id) as phages FROM defense_systems`
  ).get() ?? { count: 0, phages: 0 };

  const amgStats = db.query<{ count: number; phages: number }, []>(
    `SELECT COUNT(*) as count, COUNT(DISTINCT phage_id) as phages FROM amg_annotations`
  ).get() ?? { count: 0, phages: 0 };

  const domainDefense = db.query<{ count: number; phages: number }, []>(
    `SELECT COUNT(*) as count, COUNT(DISTINCT phage_id) as phages FROM defense_systems WHERE source = 'pfam-domain'`
  ).get() ?? { count: 0, phages: 0 };
  const domainAmg = db.query<{ count: number; phages: number }, []>(
    `SELECT COUNT(*) as count, COUNT(DISTINCT phage_id) as phages FROM amg_annotations
     WHERE json_valid(evidence) AND json_extract(evidence, '$.source') = 'pfam-domain'`
  ).get() ?? { count: 0, phages: 0 };

  const now = Date.now();
  const upsertMeta = db.prepare(`
    INSERT INTO annotation_meta (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    WHERE annotation_meta.value != excluded.value
  `);

  upsertMeta.run('domain_defense', JSON.stringify({
    count: domainDefense.count,
    phages: domainDefense.phages,
    source: 'pfam-domain',
  }), now);

  upsertMeta.run('domain_amg', JSON.stringify({
    count: domainAmg.count,
    phages: domainAmg.phages,
    source: 'pfam-domain',
  }), now);

  return {
    defenseCount: defenseStats.count,
    defensePhages: defenseStats.phages,
    amgCount: amgStats.count,
    amgPhages: amgStats.phages,
  };
}
