import type { GeneInfo } from './types';

// ============================================================================
// Types
// ============================================================================

export type ModuleId =
  | 'replication'
  | 'packaging'
  | 'capsid'
  | 'tail'
  | 'lysis'
  | 'regulation';

export type GeneRole =
  | 'polymerase' | 'primase' | 'helicase' | 'ssb' | 'ligase' | 'exonuclease'
  | 'terminase_large' | 'terminase_small' | 'portal' | 'scaffold' | 'protease'
  | 'mcp' | 'minor_capsid' | 'decoration' | 'vertex'
  | 'tail_fiber' | 'tailspike' | 'tape_measure' | 'baseplate' | 'sheath' | 'tube' | 'adapter'
  | 'holin' | 'endolysin' | 'spanin'
  | 'integrase' | 'repressor' | 'excisionase' | 'cro'
  | 'unknown';

export interface ModuleExpectation {
  id: ModuleId;
  label: string;
  keywords: string[];
  min: number;
  max?: number;
}

export interface ClassifiedGene extends GeneInfo {
  module: ModuleId | null;
  role: GeneRole;
  essentiality: 'critical' | 'common' | 'optional';
  rbsStrength: number; // 0-1, proxy for expression level
}

export interface StoichiometryRule {
  gene1: GeneRole;
  gene2: GeneRole;
  expectedRatio: number; // gene1 / gene2
  tolerance: number; // acceptable deviation
  description: string;
}

export interface StoichiometryResult {
  rule: StoichiometryRule;
  observed: number; // observed ratio
  expected: number;
  imbalance: number; // 0 = perfect, higher = worse
  isBalanced: boolean;
  gene1Count: number;
  gene2Count: number;
}

export interface ModuleStatus {
  id: ModuleId;
  label: string;
  count: number;
  min: number;
  max?: number;
  score: number; // 0..1
  completeness: number; // 0..1 weighted by essentiality
  coherence: number; // 0..1 gene adjacency score
  issues: string[];
  matchedGenes: ClassifiedGene[];
}

export interface Suggestion {
  priority: 'high' | 'medium' | 'low';
  module: ModuleId;
  message: string;
  action?: string;
}

export type QualityGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface ModuleReport {
  statuses: ModuleStatus[];
  overall: number; // 0..1
  stoichiometry: StoichiometryResult[];
  stoichiometryScore: number; // 0..1
  overallCoherence: number; // 0..1
  qualityGrade: QualityGrade;
  suggestions: Suggestion[];
  classifiedGenes: ClassifiedGene[];
}

// ============================================================================
// Constants
// ============================================================================

const EXPECTATIONS: ModuleExpectation[] = [
  {
    id: 'replication',
    label: 'Replication',
    keywords: ['polymerase', 'primase', 'helicase', 'ligase', 'exonuclease', 'dna-binding protein', 'ssb', 'single-stranded'],
    min: 1,
  },
  {
    id: 'packaging',
    label: 'Packaging',
    keywords: ['terminase', 'portal', 'head morphogenesis', 'head completion', 'prohead', 'scaffolding', 'head-tail'],
    min: 2,
  },
  {
    id: 'capsid',
    label: 'Capsid',
    keywords: ['capsid', 'coat', 'head shell', 'major capsid', 'minor capsid', 'vertex', 'decoration protein', 'mcp'],
    min: 1,
  },
  {
    id: 'tail',
    label: 'Tail',
    keywords: ['tail protein', 'tail component', 'baseplate', 'sheath', 'tube', 'tail fiber', 'tailspike', 'adapter', 'tail assembly', 'connector', 'tape measure'],
    min: 2,
  },
  {
    id: 'lysis',
    label: 'Lysis',
    keywords: ['holin', 'endolysin', 'lysin', 'spanin', 'lysozyme', 'lysis'],
    min: 1,
    max: 4,
  },
  {
    id: 'regulation',
    label: 'Regulation',
    keywords: ['repressor', 'integrase', 'excisionase', 'cro', 'transcriptional regulator', 'anti-repressor'],
    min: 0, // Lytic phages may lack regulation genes
  },
];

// Role-specific keywords for finer classification
const ROLE_KEYWORDS: Record<GeneRole, string[]> = {
  polymerase: ['polymerase', 'dna pol', 'rna pol'],
  primase: ['primase'],
  helicase: ['helicase', 'dna b'],
  ssb: ['ssb', 'single-stranded binding', 'single stranded dna binding'],
  ligase: ['ligase'],
  exonuclease: ['exonuclease', 'nuclease'],
  terminase_large: ['terminase large', 'large terminase', 'terminase subunit a', 'terlarge'],
  terminase_small: ['terminase small', 'small terminase', 'terminase subunit b', 'tersmall'],
  portal: ['portal'],
  scaffold: ['scaffold', 'scaffolding'],
  protease: ['protease', 'prohead protease'],
  mcp: ['major capsid', 'mcp', 'coat protein', 'major head'],
  minor_capsid: ['minor capsid', 'minor head'],
  decoration: ['decoration', 'hoc', 'soc'],
  vertex: ['vertex'],
  tail_fiber: ['tail fiber', 'tailfiber', 'fiber protein'],
  tailspike: ['tailspike', 'tail spike'],
  tape_measure: ['tape measure', 'tmp', 'tail length'],
  baseplate: ['baseplate', 'base plate'],
  sheath: ['sheath', 'tail sheath'],
  tube: ['tube', 'tail tube'],
  adapter: ['adapter', 'connector'],
  holin: ['holin'],
  endolysin: ['endolysin', 'lysin', 'lysozyme', 'murein hydrolase'],
  spanin: ['spanin', 'rz', 'rz1'],
  integrase: ['integrase', 'int'],
  repressor: ['repressor', 'ci'],
  excisionase: ['excisionase', 'xis'],
  cro: ['cro'],
  unknown: [],
};

// Essentiality weights for completeness scoring
const ROLE_ESSENTIALITY: Record<GeneRole, 'critical' | 'common' | 'optional'> = {
  polymerase: 'critical',
  primase: 'common',
  helicase: 'critical',
  ssb: 'common',
  ligase: 'optional',
  exonuclease: 'optional',
  terminase_large: 'critical',
  terminase_small: 'critical',
  portal: 'critical',
  scaffold: 'common',
  protease: 'common',
  mcp: 'critical',
  minor_capsid: 'common',
  decoration: 'optional',
  vertex: 'common',
  tail_fiber: 'common',
  tailspike: 'common',
  tape_measure: 'common',
  baseplate: 'common',
  sheath: 'common',
  tube: 'common',
  adapter: 'optional',
  holin: 'critical',
  endolysin: 'critical',
  spanin: 'optional',
  integrase: 'common',
  repressor: 'common',
  excisionase: 'optional',
  cro: 'optional',
  unknown: 'optional',
};

const ESSENTIALITY_WEIGHTS: Record<'critical' | 'common' | 'optional', number> = {
  critical: 1.0,
  common: 0.5,
  optional: 0.2,
};

// Stoichiometry rules: expected gene copy ratios
const STOICHIOMETRY_RULES: StoichiometryRule[] = [
  {
    gene1: 'mcp',
    gene2: 'portal',
    expectedRatio: 1, // Usually 1:1 in gene copies (protein copies differ)
    tolerance: 0.5,
    description: 'MCP:Portal ratio',
  },
  {
    gene1: 'terminase_large',
    gene2: 'terminase_small',
    expectedRatio: 1,
    tolerance: 0.5,
    description: 'Terminase large:small',
  },
  {
    gene1: 'mcp',
    gene2: 'scaffold',
    expectedRatio: 1,
    tolerance: 1,
    description: 'MCP:Scaffold ratio',
  },
  {
    gene1: 'holin',
    gene2: 'endolysin',
    expectedRatio: 1,
    tolerance: 0.5,
    description: 'Holin:Endolysin ratio',
  },
];

// Shine-Dalgarno consensus for RBS strength
const SHINE_DALGARNO = 'AGGAGG';
const SD_WEIGHTS = [1, 1, 0.8, 0.8, 0.6, 0.6]; // Position weights

// ============================================================================
// Helper Functions
// ============================================================================

function normalize(text: string | null | undefined): string {
  return (text ?? '').toLowerCase();
}

function geneMatches(expectation: ModuleExpectation, gene: GeneInfo): boolean {
  const fields = [gene.name, gene.product, gene.locusTag].map(normalize);
  return expectation.keywords.some(kw => fields.some(f => f.includes(kw)));
}

/**
 * Classify a gene into a specific role
 */
function classifyGeneRole(gene: GeneInfo): GeneRole {
  const text = normalize(`${gene.name ?? ''} ${gene.product ?? ''}`);

  for (const [role, keywords] of Object.entries(ROLE_KEYWORDS)) {
    if (role === 'unknown') continue;
    if (keywords.some(kw => text.includes(kw))) {
      return role as GeneRole;
    }
  }

  return 'unknown';
}

/**
 * Determine which module a gene belongs to based on its role
 */
function roleToModule(role: GeneRole): ModuleId | null {
  const mapping: Record<GeneRole, ModuleId | null> = {
    polymerase: 'replication',
    primase: 'replication',
    helicase: 'replication',
    ssb: 'replication',
    ligase: 'replication',
    exonuclease: 'replication',
    terminase_large: 'packaging',
    terminase_small: 'packaging',
    portal: 'packaging',
    scaffold: 'packaging',
    protease: 'packaging',
    mcp: 'capsid',
    minor_capsid: 'capsid',
    decoration: 'capsid',
    vertex: 'capsid',
    tail_fiber: 'tail',
    tailspike: 'tail',
    tape_measure: 'tail',
    baseplate: 'tail',
    sheath: 'tail',
    tube: 'tail',
    adapter: 'tail',
    holin: 'lysis',
    endolysin: 'lysis',
    spanin: 'lysis',
    integrase: 'regulation',
    repressor: 'regulation',
    excisionase: 'regulation',
    cro: 'regulation',
    unknown: null,
  };
  return mapping[role];
}

/**
 * Estimate RBS strength from upstream sequence
 * Uses Shine-Dalgarno similarity as proxy for expression level
 */
export function estimateRBSStrength(upstreamSeq: string | undefined): number {
  if (!upstreamSeq || upstreamSeq.length < 10) return 0.5; // Default

  // Look for SD-like sequence in -15 to -5 region
  const region = upstreamSeq.slice(-20, -3).toUpperCase();

  let bestScore = 0;
  for (let i = 0; i <= region.length - SHINE_DALGARNO.length; i++) {
    let score = 0;
    for (let j = 0; j < SHINE_DALGARNO.length; j++) {
      if (region[i + j] === SHINE_DALGARNO[j]) {
        score += SD_WEIGHTS[j];
      }
    }
    bestScore = Math.max(bestScore, score);
  }

  // Normalize to 0-1
  const maxScore = SD_WEIGHTS.reduce((a, b) => a + b, 0);
  return bestScore / maxScore;
}

/**
 * Compute gene adjacency coherence for a module
 * Higher score = genes in same module are located near each other
 */
function computeModuleCoherenceScore(genes: ClassifiedGene[], moduleId: ModuleId): number {
  const moduleGenes = genes.filter(g => g.module === moduleId);
  if (moduleGenes.length <= 1) return 1; // Single gene is perfectly coherent

  // Sort by start position
  const sorted = [...moduleGenes].sort((a, b) => a.startPos - b.startPos);

  let adjacentPairs = 0;
  const totalPairs = sorted.length - 1;

  for (let i = 0; i < sorted.length - 1; i++) {
    const gap = sorted[i + 1].startPos - sorted[i].endPos;
    // Consider genes adjacent if gap < 5000bp (typical operon spacing)
    if (gap < 5000) {
      adjacentPairs++;
    }
  }

  return totalPairs > 0 ? adjacentPairs / totalPairs : 1;
}

/**
 * Calculate completeness score weighted by essentiality
 */
function computeCompletenessScore(matchedGenes: ClassifiedGene[], module: ModuleExpectation): number {
  if (matchedGenes.length === 0) return 0;

  // Get unique roles found
  const rolesFound = new Set(matchedGenes.map(g => g.role).filter(r => r !== 'unknown'));

  // Expected roles for this module (based on keywords), excluding 'unknown'
  const expectedRoles = Object.entries(ROLE_KEYWORDS)
    .filter(([role]) => {
      if (role === 'unknown') return false;
      const moduleForRole = roleToModule(role as GeneRole);
      return moduleForRole === module.id;
    })
    .map(([role]) => role as Exclude<GeneRole, 'unknown'>);

  if (expectedRoles.length === 0) return matchedGenes.length >= module.min ? 1 : 0.5;

  // Weighted completeness
  let weightedFound = 0;
  let totalWeight = 0;

  for (const role of expectedRoles) {
    const essentiality = ROLE_ESSENTIALITY[role];
    const weight = ESSENTIALITY_WEIGHTS[essentiality];
    totalWeight += weight;
    if (rolesFound.has(role)) {
      weightedFound += weight;
    }
  }

  return totalWeight > 0 ? weightedFound / totalWeight : 0.5;
}

/**
 * Check stoichiometry balance
 */
function checkStoichiometry(classifiedGenes: ClassifiedGene[]): StoichiometryResult[] {
  const roleCounts: Partial<Record<GeneRole, number>> = {};

  for (const gene of classifiedGenes) {
    if (gene.role !== 'unknown') {
      roleCounts[gene.role] = (roleCounts[gene.role] || 0) + 1;
    }
  }

  return STOICHIOMETRY_RULES.map(rule => {
    const count1 = roleCounts[rule.gene1] || 0;
    const count2 = roleCounts[rule.gene2] || 0;

    // Skip if either gene is missing
    if (count1 === 0 || count2 === 0) {
      return {
        rule,
        observed: 0,
        expected: rule.expectedRatio,
        imbalance: 0,
        isBalanced: true, // Not applicable
        gene1Count: count1,
        gene2Count: count2,
      };
    }

    const observed = count1 / count2;
    const imbalance = Math.abs(Math.log2(observed / rule.expectedRatio));
    const isBalanced = imbalance <= rule.tolerance;

    return {
      rule,
      observed,
      expected: rule.expectedRatio,
      imbalance,
      isBalanced,
      gene1Count: count1,
      gene2Count: count2,
    };
  });
}

/**
 * Calculate quality grade A-F from overall scores
 */
function calculateQualityGrade(
  completeness: number,
  stoichiometry: number,
  coherence: number
): QualityGrade {
  const composite = completeness * 0.5 + stoichiometry * 0.3 + coherence * 0.2;

  if (composite >= 0.9) return 'A';
  if (composite >= 0.75) return 'B';
  if (composite >= 0.6) return 'C';
  if (composite >= 0.4) return 'D';
  return 'F';
}

/**
 * Generate suggestions for improving module health
 */
function generateSuggestions(
  statuses: ModuleStatus[],
  stoichiometry: StoichiometryResult[]
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // Module-based suggestions
  for (const status of statuses) {
    if (status.score < 0.5) {
      suggestions.push({
        priority: 'high',
        module: status.id,
        message: `${status.label} module is incomplete (${status.count}/${status.min} genes)`,
        action: `Search for missing ${status.label.toLowerCase()} genes`,
      });
    } else if (status.score < 0.8 && status.issues.length > 0) {
      suggestions.push({
        priority: 'medium',
        module: status.id,
        message: status.issues[0],
      });
    }

    if (status.coherence < 0.5) {
      suggestions.push({
        priority: 'low',
        module: status.id,
        message: `${status.label} genes are scattered (${(status.coherence * 100).toFixed(0)}% coherence)`,
        action: 'Check for annotation gaps or rearrangements',
      });
    }
  }

  // Stoichiometry suggestions
  for (const result of stoichiometry) {
    if (!result.isBalanced && result.gene1Count > 0 && result.gene2Count > 0) {
      suggestions.push({
        priority: 'medium',
        module: roleToModule(result.rule.gene1) || 'packaging',
        message: `${result.rule.description} imbalanced: ${result.gene1Count}:${result.gene2Count} (expected ~${result.expected}:1)`,
        action: 'Check for pseudogenes or annotation errors',
      });
    }
  }

  // Sort by priority
  const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return suggestions;
}

// ============================================================================
// Main Analysis Functions
// ============================================================================

/**
 * Classify all genes into modules and roles
 */
export function classifyGenes(genes: GeneInfo[], genomeSequence?: string): ClassifiedGene[] {
  return genes.map(gene => {
    const role = classifyGeneRole(gene);
    const module = roleToModule(role);
    const essentiality = ROLE_ESSENTIALITY[role];

    // Get upstream sequence for RBS if genome available
    let rbsStrength = 0.5;
    if (genomeSequence && gene.startPos > 30) {
      const upstream = genomeSequence.slice(Math.max(0, gene.startPos - 30), gene.startPos);
      rbsStrength = estimateRBSStrength(upstream);
    }

    return {
      ...gene,
      module,
      role,
      essentiality,
      rbsStrength,
    };
  });
}

/**
 * Compute comprehensive module coherence analysis
 */
export function computeModuleCoherence(genes: GeneInfo[], genomeSequence?: string): ModuleReport {
  // First classify all genes
  const classifiedGenes = classifyGenes(genes, genomeSequence);

  const statuses: ModuleStatus[] = [];

  for (const exp of EXPECTATIONS) {
    const matchedGenes = classifiedGenes.filter(g =>
      g.module === exp.id || geneMatches(exp, g)
    );
    const count = matchedGenes.length;

    let score = 1;
    const issues: string[] = [];

    if (count < exp.min) {
      score = count === 0 ? 0 : 0.5;
      if (exp.min > 0) {
        issues.push(`Missing ${exp.min - count} required gene(s)`);
      }
    }

    if (exp.max !== undefined && count > exp.max) {
      score = Math.min(score, 0.6);
      issues.push(`Possible excess (${count}/${exp.max})`);
    }

    const completeness = computeCompletenessScore(matchedGenes, exp);
    const coherence = computeModuleCoherenceScore(classifiedGenes, exp.id);

    // Adjust score based on completeness and coherence
    score = score * 0.5 + completeness * 0.3 + coherence * 0.2;

    statuses.push({
      id: exp.id,
      label: exp.label,
      count,
      min: exp.min,
      max: exp.max,
      score,
      completeness,
      coherence,
      issues,
      matchedGenes,
    });
  }

  // Check stoichiometry
  const stoichiometry = checkStoichiometry(classifiedGenes);
  const applicableRules = stoichiometry.filter(r => r.gene1Count > 0 && r.gene2Count > 0);
  const stoichiometryScore = applicableRules.length > 0
    ? applicableRules.filter(r => r.isBalanced).length / applicableRules.length
    : 1;

  // Calculate overall scores
  const overall = statuses.reduce((sum, s) => sum + s.score, 0) / statuses.length;
  const overallCoherence = statuses.reduce((sum, s) => sum + s.coherence, 0) / statuses.length;

  // Quality grade
  const qualityGrade = calculateQualityGrade(overall, stoichiometryScore, overallCoherence);

  // Generate suggestions
  const suggestions = generateSuggestions(statuses, stoichiometry);

  return {
    statuses,
    overall,
    stoichiometry,
    stoichiometryScore,
    overallCoherence,
    qualityGrade,
    suggestions,
    classifiedGenes,
  };
}

// ============================================================================
// Backward Compatibility
// ============================================================================

// Keep the old simple interface for existing uses
export type { GeneInfo };
