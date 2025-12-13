import { sqliteTable, text, integer, real, blob, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

// Main phages catalog table
export const phages = sqliteTable('phages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').unique(),
  name: text('name').notNull(),
  accession: text('accession').unique().notNull(),
  family: text('family'),
  genus: text('genus'),
  host: text('host'),
  morphology: text('morphology'), // siphovirus, myovirus, podovirus, filamentous, etc.
  lifecycle: text('lifecycle'), // lytic, lysogenic, chronic
  genomeLength: integer('genome_length'),
  genomeType: text('genome_type'), // dsDNA, ssDNA, dsRNA, ssRNA
  gcContent: real('gc_content'),
  baltimoreGroup: text('baltimore_group'),
  description: text('description'),
  pdbIds: text('pdb_ids'), // JSON array of PDB IDs
  tags: text('tags'), // JSON for quick flags
  lastUpdated: integer('last_updated'), // unix timestamp
});

// Chunked sequences table - stores genome in 10kb chunks
export const sequences = sqliteTable('sequences', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phageId: integer('phage_id').notNull().references(() => phages.id),
  chunkIndex: integer('chunk_index').notNull(),
  sequence: text('sequence').notNull(),
}, (table) => [
  uniqueIndex('idx_sequences_phage_chunk').on(table.phageId, table.chunkIndex),
  index('idx_sequences_phage').on(table.phageId),
]);

// Gene annotations table
export const genes = sqliteTable('genes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phageId: integer('phage_id').notNull().references(() => phages.id),
  name: text('name'),
  locusTag: text('locus_tag'),
  startPos: integer('start_pos').notNull(),
  endPos: integer('end_pos').notNull(),
  strand: text('strand'), // '+' or '-'
  product: text('product'),
  type: text('type'), // CDS, gene, promoter, terminator, etc.
  qualifiers: text('qualifiers'), // JSON bag
}, (table) => [
  index('idx_genes_phage').on(table.phageId),
  index('idx_genes_position').on(table.phageId, table.startPos, table.endPos),
]);

// Codon usage statistics
export const codonUsage = sqliteTable('codon_usage', {
  phageId: integer('phage_id').primaryKey().references(() => phages.id),
  aaCounts: text('aa_counts').notNull(), // JSON: { "A": 1234, "R": 567, ... }
  codonCounts: text('codon_counts').notNull(), // JSON: { "ATG": 10, "TTT": 23, ... }
});

// 3D models table with optional pre-rendered ASCII frames
export const models = sqliteTable('models', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phageId: integer('phage_id').notNull().references(() => phages.id),
  role: text('role').notNull(), // capsid, tail, full_virion
  pdbId: text('pdb_id'),
  source: text('source').notNull(), // pdb, sketchfab, custom
  objData: blob('obj_data'), // simplified OBJ/STL data
  asciiFrames: text('ascii_frames'), // JSON array of pre-rendered frames
  meta: text('meta'), // JSON metadata, citations, resolution
}, (table) => [
  index('idx_models_phage').on(table.phageId),
]);

// Tail fiber tropism predictions (precomputed via embeddings/ONNX)
export const tropismPredictions = sqliteTable('tropism_predictions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phageId: integer('phage_id').notNull().references(() => phages.id),
  geneId: integer('gene_id').references(() => genes.id),
  locusTag: text('locus_tag'),
  receptor: text('receptor').notNull(),
  confidence: real('confidence').notNull(), // 0-1
  evidence: text('evidence'), // JSON array of strings
  source: text('source').notNull(), // e.g., esm2-hdbscan, heuristic
}, (table) => [
  index('idx_tropism_phage').on(table.phageId),
  index('idx_tropism_gene').on(table.geneId),
]);

// User preferences
export const preferences = sqliteTable('preferences', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ============================================================================
// PRECOMPUTED ANNOTATION TABLES (populated via GitHub Actions)
// ============================================================================

// Protein domain annotations from InterPro/Pfam
export const proteinDomains = sqliteTable('protein_domains', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phageId: integer('phage_id').notNull().references(() => phages.id),
  geneId: integer('gene_id').references(() => genes.id),
  locusTag: text('locus_tag'),
  domainId: text('domain_id').notNull(), // e.g., "PF00145", "IPR001650"
  domainName: text('domain_name'), // e.g., "DNA_pol_B"
  domainType: text('domain_type'), // "Pfam", "SMART", "CDD", etc.
  start: integer('start'),
  end: integer('end'),
  score: real('score'),
  eValue: real('e_value'),
  description: text('description'),
}, (table) => [
  index('idx_domains_phage').on(table.phageId),
  index('idx_domains_gene').on(table.geneId),
  index('idx_domains_domain').on(table.domainId),
]);

// Auxiliary Metabolic Gene (AMG) annotations
export const amgAnnotations = sqliteTable('amg_annotations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phageId: integer('phage_id').notNull().references(() => phages.id),
  geneId: integer('gene_id').references(() => genes.id),
  locusTag: text('locus_tag'),
  amgType: text('amg_type').notNull(), // e.g., "photosynthesis", "nucleotide", "carbon"
  keggOrtholog: text('kegg_ortholog'), // e.g., "K02703" (psbA)
  keggReaction: text('kegg_reaction'), // e.g., "R00024"
  keggPathway: text('kegg_pathway'), // e.g., "ko00195"
  pathwayName: text('pathway_name'), // e.g., "Photosynthesis"
  confidence: real('confidence'),
  evidence: text('evidence'), // JSON array
}, (table) => [
  index('idx_amg_phage').on(table.phageId),
  index('idx_amg_type').on(table.amgType),
]);

// Phage defense/counter-defense systems
export const defenseSystems = sqliteTable('defense_systems', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phageId: integer('phage_id').notNull().references(() => phages.id),
  geneId: integer('gene_id').references(() => genes.id),
  locusTag: text('locus_tag'),
  systemType: text('system_type').notNull(), // "anti-CRISPR", "anti-RM", "anti-Abi"
  systemFamily: text('system_family'), // e.g., "AcrIIA4", "Ocr"
  targetSystem: text('target_system'), // e.g., "Type II-A CRISPR", "Type I RM"
  mechanism: text('mechanism'), // Brief description
  confidence: real('confidence'),
  source: text('source'), // "AcrDB", "DefenseFinder", "heuristic"
}, (table) => [
  index('idx_defense_phage').on(table.phageId),
  index('idx_defense_type').on(table.systemType),
]);

// Host tRNA pools for codon adaptation analysis
export const hostTrnaPools = sqliteTable('host_trna_pools', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  hostName: text('host_name').notNull(), // e.g., "Escherichia coli K-12"
  hostTaxId: integer('host_tax_id'),
  anticodon: text('anticodon').notNull(), // e.g., "CAU"
  aminoAcid: text('amino_acid').notNull(), // e.g., "Met"
  codon: text('codon'), // The codon this anticodon recognizes
  copyNumber: integer('copy_number'),
  relativeAbundance: real('relative_abundance'),
}, (table) => [
  index('idx_trna_host').on(table.hostName),
  index('idx_trna_anticodon').on(table.anticodon),
]);

// Precomputed codon adaptation scores per phage-host pair
export const codonAdaptation = sqliteTable('codon_adaptation', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  phageId: integer('phage_id').notNull().references(() => phages.id),
  hostName: text('host_name').notNull(),
  geneId: integer('gene_id').references(() => genes.id), // NULL for whole-genome
  locusTag: text('locus_tag'),
  cai: real('cai'), // Codon Adaptation Index
  tai: real('tai'), // tRNA Adaptation Index
  cpb: real('cpb'), // Codon Pair Bias
  encPrime: real('enc_prime'), // Nc' (expected Nc given GC)
}, (table) => [
  index('idx_adaptation_phage').on(table.phageId),
  index('idx_adaptation_host').on(table.hostName),
]);

// Annotation metadata (tracks when annotations were last updated)
export const annotationMeta = sqliteTable('annotation_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at'),
});

// Type exports for use in other packages
export type Phage = typeof phages.$inferSelect;
export type NewPhage = typeof phages.$inferInsert;

export type Sequence = typeof sequences.$inferSelect;
export type NewSequence = typeof sequences.$inferInsert;

export type Gene = typeof genes.$inferSelect;
export type NewGene = typeof genes.$inferInsert;

export type CodonUsage = typeof codonUsage.$inferSelect;
export type NewCodonUsage = typeof codonUsage.$inferInsert;

export type Model = typeof models.$inferSelect;
export type NewModel = typeof models.$inferInsert;

export type Preference = typeof preferences.$inferSelect;
export type NewPreference = typeof preferences.$inferInsert;

export type TropismPrediction = typeof tropismPredictions.$inferSelect;
export type NewTropismPrediction = typeof tropismPredictions.$inferInsert;

// New annotation table types
export type ProteinDomain = typeof proteinDomains.$inferSelect;
export type NewProteinDomain = typeof proteinDomains.$inferInsert;

export type AmgAnnotation = typeof amgAnnotations.$inferSelect;
export type NewAmgAnnotation = typeof amgAnnotations.$inferInsert;

export type DefenseSystem = typeof defenseSystems.$inferSelect;
export type NewDefenseSystem = typeof defenseSystems.$inferInsert;

export type HostTrnaPool = typeof hostTrnaPools.$inferSelect;
export type NewHostTrnaPool = typeof hostTrnaPools.$inferInsert;

export type CodonAdaptation = typeof codonAdaptation.$inferSelect;
export type NewCodonAdaptation = typeof codonAdaptation.$inferInsert;

export type AnnotationMeta = typeof annotationMeta.$inferSelect;
export type NewAnnotationMeta = typeof annotationMeta.$inferInsert;
