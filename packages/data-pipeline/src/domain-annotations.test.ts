import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  detectDomainDefenseSystems,
  detectDomainAmgs,
  updateDomainAnnotations,
  refreshDomainAnnotationMetadata,
  PFAM_DEFENSE_RULES,
  PFAM_AMG_RULES,
} from './domain-annotations';

describe('domain-annotations', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.run(`
      CREATE TABLE protein_domains (
        id INTEGER PRIMARY KEY,
        phage_id INTEGER NOT NULL,
        gene_id INTEGER,
        locus_tag TEXT,
        domain_id TEXT NOT NULL,
        domain_name TEXT,
        domain_type TEXT,
        start INTEGER,
        end INTEGER,
        score REAL,
        e_value REAL,
        description TEXT
      );
      CREATE TABLE defense_systems (
        id INTEGER PRIMARY KEY,
        phage_id INTEGER NOT NULL,
        gene_id INTEGER,
        locus_tag TEXT,
        system_type TEXT NOT NULL,
        system_family TEXT,
        target_system TEXT,
        mechanism TEXT,
        confidence REAL,
        source TEXT
      );
      CREATE TABLE amg_annotations (
        id INTEGER PRIMARY KEY,
        phage_id INTEGER NOT NULL,
        gene_id INTEGER,
        locus_tag TEXT,
        amg_type TEXT NOT NULL,
        kegg_ortholog TEXT,
        kegg_reaction TEXT,
        kegg_pathway TEXT,
        pathway_name TEXT,
        confidence REAL,
        evidence TEXT
      );
      CREATE TABLE annotation_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  it('detects defense systems from Pfam domains', () => {
    // Insert Ocr and Ral domains
    db.run(`
      INSERT INTO protein_domains (phage_id, gene_id, locus_tag, domain_id, domain_name, description, e_value)
      VALUES 
        (1, 10, 'gpOcr', 'PF08684', 'ocr', 'DNA mimic ocr', 1e-20),
        (2, 20, 'gpRal', 'PF11058', 'Ral', 'Antirestriction protein Ral', 1e-15);
    `);

    const hits = detectDomainDefenseSystems(db, PFAM_DEFENSE_RULES);
    expect(hits.length).toBe(2);

    const ocrHit = hits.find(h => h.systemFamily === 'Ocr');
    expect(ocrHit).toBeDefined();
    expect(ocrHit?.systemType).toBe('anti-RM');
    expect(ocrHit?.source).toBe('pfam-domain');
    expect(ocrHit?.confidence).toBe(0.98);

    const ralHit = hits.find(h => h.systemFamily === 'Ral');
    expect(ralHit).toBeDefined();
    expect(ralHit?.systemType).toBe('anti-RM');
    expect(ralHit?.confidence).toBe(0.95);
  });

  it('detects auxiliary metabolic genes (AMGs) from Pfam domains', () => {
    // Insert PsbA and ThyA domains
    db.run(`
      INSERT INTO protein_domains (phage_id, gene_id, locus_tag, domain_id, domain_name, description, e_value, score)
      VALUES 
        (1, 101, 'psbA_gene', 'PF00124', 'Photosystem_II', 'Photosystem II reaction centre D1', 1e-50, 250.0),
        (2, 202, 'thyA_gene', 'PF00303', 'Thymidylat_synt', 'Thymidylate synthase', 1e-30, 180.0);
    `);

    const hits = detectDomainAmgs(db, PFAM_AMG_RULES);
    expect(hits.length).toBe(2);

    const psbHit = hits.find(h => h.keggOrtholog === 'K02703');
    expect(psbHit).toBeDefined();
    expect(psbHit?.amgType).toBe('photosynthesis');
    expect(psbHit?.confidence).toBe(0.98);

    const thyHit = hits.find(h => h.keggOrtholog === 'K00560');
    expect(thyHit).toBeDefined();
    expect(thyHit?.amgType).toBe('nucleotide-metabolism');
    expect(thyHit?.pathwayName).toBe('Pyrimidine metabolism');
  });

  it('deduplicates multiple sub-domains on the same gene for defense and AMG calls', () => {
    // Large subunit ribonucleotide reductase can match both barrel (PF02867) and alpha (PF00317)
    db.run(`
      INSERT INTO protein_domains (phage_id, gene_id, locus_tag, domain_id, domain_name, description, e_value, score)
      VALUES 
        (1, 101, 'rnr_lg', 'PF02867', 'Ribonuc_red_lgC', 'Ribonucleotide reductase, barrel domain', 1e-40, 200.0),
        (1, 101, 'rnr_lg', 'PF00317', 'Ribonuc_red_lgN', 'Ribonucleotide reductase, all-alpha domain', 1e-30, 150.0);
    `);

    const hits = detectDomainAmgs(db, PFAM_AMG_RULES);
    expect(hits.length).toBe(1);
    expect(hits[0].keggOrtholog).toBe('K00525');
  });

  it('updates database tables and retains esm2-nn rows while updating meta table', () => {
    // Seed existing esm2-nn defense row and old heuristic row
    db.run(`
      INSERT INTO defense_systems (phage_id, gene_id, locus_tag, system_type, system_family, target_system, mechanism, confidence, source)
      VALUES 
        (1, 5, 'acr1', 'anti-CRISPR', 'AcrIIA4', 'Type II-A CRISPR-Cas', 'Inhibits Cas9', 0.99, 'esm2-nn'),
        (1, 6, 'old_anti', 'anti-RM', 'unknown', 'Type I', 'Old heuristic', 0.5, 'heuristic');
      INSERT INTO amg_annotations (phage_id, gene_id, locus_tag, amg_type, kegg_ortholog, pathway_name, confidence, evidence)
      VALUES 
        (1, 7, 'old_amg', 'photosynthesis', 'K02703', 'Photosynthesis', 0.8, 'keyword');
      INSERT INTO protein_domains (phage_id, gene_id, locus_tag, domain_id, domain_name, description, e_value, score)
      VALUES 
        (1, 10, 'gpOcr', 'PF08684', 'ocr', 'DNA mimic ocr', 1e-20, 100.0),
        (1, 20, 'thyA', 'PF00303', 'Thymidylat_synt', 'Thymidylate synthase', 1e-30, 180.0);
    `);

    const result = updateDomainAnnotations(db);

    expect(result.defenseCount).toBe(2); // 1 esm2-nn + 1 pfam-domain
    expect(result.amgCount).toBe(1); // 1 domain AMG

    const defenseRows = db.query<{ source: string; system_type: string }, []>(
      `SELECT source, system_type FROM defense_systems ORDER BY source`
    ).all();
    expect(defenseRows.length).toBe(2);
    expect(defenseRows.some(r => r.source === 'esm2-nn')).toBe(true);
    expect(defenseRows.some(r => r.source === 'pfam-domain')).toBe(true);

    const amgRows = db.query<{ amg_type: string; evidence: string }, []>(
      `SELECT amg_type, evidence FROM amg_annotations`
    ).all();
    expect(amgRows.length).toBe(1);
    expect(amgRows[0].evidence).toContain('pfam-domain');

    const metaRows = db.query<{ key: string; value: string }, []>(
      `SELECT key, value FROM annotation_meta`
    ).all();
    expect(metaRows.some(m => m.key === 'domain_defense')).toBe(true);
    expect(metaRows.some(m => m.key === 'domain_amg')).toBe(true);
    expect(JSON.parse(metaRows.find(m => m.key === 'domain_defense')!.value)).toMatchObject({ count: 1, phages: 1 });
  });

  it('refreshes stale coverage without changing annotations or churning unchanged metadata', () => {
    db.run(`INSERT INTO defense_systems (phage_id, system_type, source) VALUES
      (1, 'anti-RM', 'pfam-domain'), (2, 'anti-RM', 'pfam-domain'), (3, 'anti-CRISPR', 'esm2-nn')`);
    db.run(`INSERT INTO annotation_meta VALUES ('domain_defense', '{"count":87,"phages":15}', 1)`);
    const result = refreshDomainAnnotationMetadata(db);
    expect(result.defenseCount).toBe(3);
    const first = db.query<{ value: string; updated_at: number }, []>(
      `SELECT value, updated_at FROM annotation_meta WHERE key='domain_defense'`
    ).get()!;
    expect(JSON.parse(first.value)).toEqual({ count: 2, phages: 2, source: 'pfam-domain' });
    expect(db.query('SELECT COUNT(*) AS n FROM defense_systems').get()).toEqual({ n: 3 });
    refreshDomainAnnotationMetadata(db);
    expect(db.query(`SELECT value, updated_at FROM annotation_meta WHERE key='domain_defense'`).get()).toEqual(first);
    // Removing screening candidates from this in-memory fixture changes total
    // coverage without presenting the candidates as Pfam-supported calls.
    db.run("DELETE FROM defense_systems WHERE source='esm2-nn'");
    expect(refreshDomainAnnotationMetadata(db)).toMatchObject({ defenseCount: 2, defensePhages: 2 });
    expect(db.query(`SELECT value, updated_at FROM annotation_meta WHERE key='domain_defense'`).get()).toEqual(first);
  });
});
