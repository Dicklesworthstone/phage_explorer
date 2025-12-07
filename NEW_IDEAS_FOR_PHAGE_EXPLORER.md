# Big-Idea Roadmap for Phage Explorer

Ten implementation-ready, high-wattage upgrades that combine advanced math, statistics, and phage biology. Each entry lists how to build it, why it matters, novelty, teaching value, and TUI “wow”.


## 1) Pan-Phage Latent Space Atlas (Protein Embedding Galaxy)

### Concept
Learn a continuous manifold of phage genomes and proteins to expose evolutionary neighborhoods, functional clusters, and modular swaps. Traditional function prediction via BLAST fails for ~50% of phage genes ("viral dark matter"). Modern protein language models (ESM-2, ProtTrans) learn evolutionary and functional information, producing embeddings where proximity = functional similarity even without sequence homology.

### How to Build

**Dual-level embeddings:**
1. **Genome-level**: VAE with dual encoder — (a) k-mer CNN/Transformer over DNA; (b) gene-order graph via Graph Attention Networks (PyTorch + torch-geometric)
2. **Protein-level**: ESM-2 embeddings (1280-dim vectors) capturing evolutionary context, secondary structure, functional domains

**Implementation options:**
- **Full ML**: Train VAE in PyTorch, export embeddings, cache in SQLite
- **Lightweight alternative**: Pre-compute ESM-2 embeddings during database build (Python script), store in new `protein_embeddings` table
- **Fallback for offline**: k-mer frequencies + physico-chemical descriptors (no ML required)

**Database schema addition:**
```sql
CREATE TABLE protein_embeddings (
  protein_id INTEGER PRIMARY KEY,
  phage_id INTEGER NOT NULL,
  gene_name TEXT,
  embedding BLOB,     -- Float32Array serialized (1280 dims for ESM-2)
  umap_x REAL,        -- Pre-computed 2D projection
  umap_y REAL,
  cluster_id INTEGER, -- HDBSCAN cluster assignment
  novelty_score REAL, -- Distance to nearest known-function cluster
  FOREIGN KEY (phage_id) REFERENCES phages(id)
);
```

**Dimensionality reduction:**
```typescript
// UMAP parameters tuned for protein space
const reducer = new UMAP({
  nNeighbors: 15,    // Local vs global structure balance
  minDist: 0.1,      // Clustering tightness
  metric: 'cosine'   // Better for high-dim embeddings
});
const coords2D = reducer.fit(embeddings);
```

**Clustering for function inference:**
```typescript
// HDBSCAN: density-based, no need to specify k
import { HDBSCAN } from 'density-clustering';
const clusterer = new HDBSCAN({ minClusterSize: 5, minSamples: 3 });
const labels = clusterer.fit(embeddings);

// Outliers (label = -1) are potentially novel functions
const novelProteins = proteins.filter((_, i) => labels[i] === -1);
```

**Cross-proteome comparison:**
```typescript
// Hungarian algorithm for optimal protein matching between phages
function compareProteomes(embeddingsA: Float32Array[], embeddingsB: Float32Array[]) {
  const costMatrix = embeddingsA.map(a =>
    embeddingsB.map(b => cosineDistance(a, b))
  );
  const assignment = hungarian(costMatrix);
  return {
    matchedPairs: assignment,
    similarity: 1 - meanCost(assignment, costMatrix)
  };
}
```

### Why Good/New
- Moves beyond pairwise BLAST to global structure
- Reveals mosaicism and host jumps at a glance
- **Breaks the homology barrier**: Find functions for hypothetical proteins
- **Discovery**: Isolated points in embedding space = truly novel proteins
- Few phage TUIs offer latent-space navigation; none integrate protein language models

### Pedagogical Value: 9/10
Teaches:
- Manifold learning and dimensionality reduction (UMAP/t-SNE)
- Protein language models and evolutionary encoding
- Clustering algorithms (HDBSCAN vs k-means)
- Functional inference via "guilt by association"
- The challenge of viral dark matter

### Wow/TUI: "Galaxy" Visualization
```
Protein Embedding Galaxy: Lambda + T4 + T7
┌────────────────────────────────────────────────────────────────┐
│                     ∴                                          │
│                    ∴∴∴∴     Tail fibers (cluster 7)            │
│                   ∴∴∴∴∴                                        │
│  Lysins ∘∘∘                                                    │
│         ∘∘∘∘                    ⊙⊙⊙                            │
│                                ⊙⊙⊙⊙⊙  DNA replication          │
│     ∴                         ⊙⊙⊙⊙⊙   (cluster 3)              │
│                                                                │
│                              ⊛ ← UNKNOWN (isolated, novel?)    │
│                                                                │
│        ○○○○○  Capsid                                           │
│       ○○○○○○  (cluster 1)                   ∘∘                 │
│        ○○○○                                ∘∘∘∘  Hypothetical  │
└────────────────────────────────────────────────────────────────┘
Legend: ∴ Lambda  ○ T4  ⊙ T7  ⊛ Unknown/Novel

[←/→] Pan   [+/-] Zoom   [Enter] Inspect cluster   [F] Filter by function
```

**Cluster detail view:**
```
Cluster 5: "Tail fiber proteins" (12 members, 87% confidence)
┌─────────────────────────────────────────────────────────────┐
│ Protein          │ Phage    │ Annotation          │ Conf.   │
├─────────────────────────────────────────────────────────────┤
│ gpJ              │ Lambda   │ Tail fiber          │ Known   │
│ gp37             │ T4       │ Long tail fiber     │ Known   │
│ gp38             │ T4       │ Tail fiber assembly │ Known   │
│ orf42            │ P22      │ Hypothetical        │ 87% ✓   │
│ orf18            │ Mu       │ Tail fiber (pred.)  │ 72% ✓   │
└─────────────────────────────────────────────────────────────┘

Function inferred from cluster membership (not sequence homology)
```

## 2) Recombination Hotspot Radar (Phylogenetic Mosaic Atlas)

### Concept
Phage genomes are not trees — they're **tangles**. Rampant horizontal gene transfer means a single phage is a mosaic assembled from potentially dozens of ancestral lineages. This feature detects mosaic ancestry along genomes, flags recombination breakpoints, and **colors each gene by its phylogenetic origin** — revealing the true chimeric nature of phage evolution.

### Mathematical Foundations

**Per-gene phylogenetics:**
```
For each ortholog cluster G across N phages:
  1. Multiple sequence alignment (progressive or iterative)
  2. Distance matrix: D[i,j] = 1 - sequence_identity(i, j)
  3. Tree construction via Neighbor-Joining: O(n³)
     - Find minimum D[i,j], create internal node
     - Update distances, repeat until rooted
  4. Optional: ML refinement with Jukes-Cantor/GTR model
```

**Recombination breakpoint detection (PHI test):**
```
For concatenated alignment:
  1. Compute pairwise incompatibility matrix
  2. I(i,j) = 1 if sites i,j violate four-gamete test
  3. PHI statistic = mean(I(i,j)) for nearby site pairs
  4. Significance via permutation (P < 0.05 = recombination)
  5. Breakpoints where PHI changes significantly
```

**Gene flow quantification:**
```
For each gene tree vs species tree:
  - Robinson-Foulds distance measures topological disagreement
  - Low RF = vertical inheritance (gene follows species)
  - High RF = horizontal transfer (gene has different history)

Transfer direction inferred from branch length asymmetry.
```

**Phylogenetic HMM for mosaic detection:**
```
States = {Donor_1, Donor_2, ..., Donor_k} (ancestral lineages)
Emissions = local sequence similarity to each donor
Transitions = low probability (encourage few switches)

Viterbi decoding gives most likely ancestry path.
Posterior decoding gives per-position confidence.
```

### How to Build

**Core algorithms in Rust/WASM:**
```rust
// Neighbor-Joining tree construction
pub fn neighbor_joining(dist: &Array2<f64>) -> NewickTree {
    let n = dist.nrows();
    let mut d = dist.clone();
    let mut nodes: Vec<TreeNode> = (0..n).map(|i| TreeNode::Leaf(i)).collect();

    while nodes.len() > 2 {
        // Compute Q matrix
        let q = compute_q_matrix(&d);

        // Find minimum Q[i,j]
        let (i, j) = find_min_pair(&q);

        // Create new internal node
        let new_node = TreeNode::Internal {
            left: Box::new(nodes[i].clone()),
            right: Box::new(nodes[j].clone()),
            left_dist: compute_branch_length(&d, i, j, true),
            right_dist: compute_branch_length(&d, i, j, false),
        };

        // Update distance matrix
        d = update_distances(&d, i, j);
        nodes = update_nodes(nodes, i, j, new_node);
    }

    NewickTree::from_nodes(nodes)
}

// PHI test for recombination
pub fn phi_test(alignment: &[&str], window: usize) -> PhiResult {
    let sites: Vec<Vec<u8>> = parse_alignment(alignment);
    let n_sites = sites.len();

    let mut incompatibilities = 0;
    let mut comparisons = 0;

    for i in 0..n_sites {
        for j in (i + 1).min(i + window)..n_sites.min(i + window) {
            if violates_four_gamete(&sites[i], &sites[j]) {
                incompatibilities += 1;
            }
            comparisons += 1;
        }
    }

    let phi = incompatibilities as f64 / comparisons as f64;
    let p_value = permutation_test(&sites, phi, 1000);

    PhiResult { phi, p_value, significant: p_value < 0.05 }
}
```

**TypeScript orchestration:**
```typescript
interface MosaicResult {
  geneTrees: Map<string, NewickTree>;
  speciesTree: NewickTree;
  breakpoints: RecombinationBreakpoint[];
  geneOrigins: Map<string, { gene: string; origin: string; confidence: number }>;
  transferEvents: GeneFlowEdge[];
}

async function computeMosaicAtlas(phages: PhageFull[]): Promise<MosaicResult> {
  // 1. Cluster orthologs across phages
  const orthologs = await clusterOrthologs(phages);

  // 2. Build per-gene trees (parallel in WASM)
  const geneTrees = await buildGeneTrees(orthologs);

  // 3. Build species tree from concatenated core genes
  const coreGenes = identifyCoreGenes(geneTrees);
  const speciesTree = buildSpeciesTree(coreGenes);

  // 4. Detect recombination breakpoints
  const breakpoints = await detectBreakpoints(phages, geneTrees);

  // 5. Assign gene origins by comparing to species tree
  const geneOrigins = assignOrigins(geneTrees, speciesTree);

  // 6. Infer gene flow events
  const transferEvents = inferTransfers(geneOrigins, speciesTree);

  return { geneTrees, speciesTree, breakpoints, geneOrigins, transferEvents };
}
```

### Why Good/New
- Brings genome painting (common in bacteria) to phages with lightweight computations
- **Visualizes the TRUE evolutionary history** — not just presence/absence but origin
- Reveals which genes are "promiscuous" (jump frequently) vs "faithful" (co-evolve)
- **Identifies core vs accessory genome** at a glance
- No existing tool combines phylogenetics + mosaic visualization interactively

### Pedagogical Value: 10/10
Teaches:
- **Horizontal gene transfer**: The defining feature of phage evolution
- **Phylogenetic trees**: Distance matrices, Neighbor-Joining, ML methods
- **Mosaic evolution**: Genes as independent evolutionary units
- **HMMs**: State machines for biological sequence analysis
- **Four-gamete test**: Classic population genetics

### Wow/TUI: Animated Mosaic Sweep
```
Phylogenetic Mosaic: Lambda phage

Gene origins (colored by ancestral lineage):
╔══════════════════════════════════════════════════════════════════╗
║▓▓▓▓▓▓░░░░░▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒▓▓▓▓▓▓▓▓▓░░░░░░▓▓▓▓▓▓║
╚══════════════════════════════════════════════════════════════════╝
Legend: ▓ Lambda-like  ░ T7-like  ▒ Unknown/Novel  ━ Core (vertical)

Breakpoints detected:
  Position 12,400: Lambda→T7-like (conf: 94%) ──────────────╮
  Position 28,100: T7-like→Unknown (conf: 78%)               │
  Position 35,600: Unknown→Lambda-like (conf: 91%)           │
                                                             ▼
Gene tree discordance:     ╭──────────────────────────────────╮
  CI repressor     RF=2  ━━│ Matches species tree (vertical)  │
  N antiterminator RF=8  ░░│ Different origin (HGT likely)    │
  tail fiber gpJ   RF=12 ▒▒│ Highly discordant (recent HGT)   │
                           ╰──────────────────────────────────╯
```

**Sankey-style gene flow (ASCII):**
```
Gene flow into Lambda genome:

T4-like ═══════╗
               ╠══════════════▶ Tail assembly module
Lambda-like ═══╝

               ╔══════════════▶ Lysis cassette
Unknown ═══════╝

Lambda-like ═══════════════════▶ Regulatory (CI/Cro)
                                 [vertical inheritance]
```

**Animated HMM walk:**
```
[▶ Play] Mosaic HMM walking genome...

Position: 15,420 / 48,502
Current state: T7-like (posterior: 0.87)

         Lambda  T7-like  Unknown
Posterior: 0.08    0.87     0.05
           ░░░░    ████     ░░░░
                    ▲ most likely
```

## 3) Structural Epitope Clash Map (Tail Fiber Host Range Analyzer)

### Concept
The tail fiber is the phage's **molecular key** — its receptor-binding domain (RBD) determines host specificity. This feature combines structural analysis with sequence-based host range prediction:
1. **Structural analysis**: ΔΔG alanine scans and electrostatics on predicted structures
2. **Modular domain detection**: Identify N-anchor, shaft, and hypervariable RBD regions
3. **Entropy-based variability mapping**: Find conserved vs rapidly-evolving positions
4. **Host range prediction**: Infer likely hosts from RBD sequence features

### Mathematical Foundations

**Shannon entropy for per-position variability:**
```
For each position i in a multiple sequence alignment:
  H(i) = -Σ p(a) × log₂(p(a))

Where p(a) = frequency of amino acid a at position i

H(i) = 0: Perfectly conserved (functional constraint)
H(i) = 4.3: Maximum entropy (20 AA, no constraint)

Entropy profile reveals:
  - Low entropy in anchor/shaft = structural requirement
  - High entropy in RBD = host-range variability
```

**Domain boundary detection:**
```
Tail fibers have conserved modular structure:
  [N-terminal anchor] — [Shaft repeats] — [RBD]

Detect boundaries by:
  1. Entropy gradient peaks (sudden variability change)
  2. Hydropathy profile transitions
  3. Secondary structure predictions (α-helix shaft → β-sheet RBD)
  4. Recombination breakpoint detection (if comparing homologs)
```

**Structural stability (ΔΔG):**
```
For each residue r:
  ΔΔG = ΔG(wild-type) - ΔG(alanine mutant)

High ΔΔG = structurally important (core)
Low ΔΔG = surface-exposed, tolerant to mutation
Negative ΔΔG = destabilizing, likely under selection
```

**Host range prediction features:**
```
For ML model predicting host from RBD sequence:
  - K-mer frequencies (k=3,4,5)
  - Amino acid composition (charged, hydrophobic, aromatic)
  - Predicted secondary structure composition
  - Isoelectric point, molecular weight
  - Specific motifs (carbohydrate-binding domains, Ig-like folds)
```

### How to Build

**Entropy calculation:**
```typescript
function positionEntropy(alignment: string[], position: number): number {
  const counts = new Map<string, number>();
  let total = 0;

  for (const seq of alignment) {
    const aa = seq[position];
    if (aa !== '-' && aa !== 'X') {
      counts.set(aa, (counts.get(aa) || 0) + 1);
      total++;
    }
  }

  if (total === 0) return 0;

  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / total;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

function entropyProfile(alignment: string[]): number[] {
  const length = alignment[0].length;
  return Array.from({ length }, (_, i) => positionEntropy(alignment, i));
}
```

**Domain boundary detection:**
```typescript
interface DomainBoundary {
  position: number;
  type: 'anchor_end' | 'shaft_end' | 'rbd_start';
  confidence: number;
}

function detectDomainBoundaries(
  entropy: number[],
  hydropathy: number[],
  secondaryStructure: string[]  // 'H' helix, 'E' sheet, 'C' coil
): DomainBoundary[] {
  const boundaries: DomainBoundary[] = [];

  // Compute entropy gradient
  const gradient = entropy.map((e, i) =>
    i > 0 ? Math.abs(e - entropy[i - 1]) : 0
  );

  // Find peaks in gradient (domain transitions)
  const peaks = findPeaks(gradient, { threshold: 0.5, minDistance: 20 });

  for (const peak of peaks) {
    // Classify based on position and structure context
    const avgEntropyBefore = mean(entropy.slice(Math.max(0, peak - 20), peak));
    const avgEntropyAfter = mean(entropy.slice(peak, peak + 20));

    if (avgEntropyBefore < 1.0 && avgEntropyAfter > 2.0) {
      boundaries.push({
        position: peak,
        type: 'rbd_start',
        confidence: Math.min(1, (avgEntropyAfter - avgEntropyBefore) / 2)
      });
    }
  }

  return boundaries;
}
```

**Host range prediction:**
```typescript
interface HostPrediction {
  genus: string;
  species?: string;
  confidence: number;
  evidence: string[];
}

function predictHostRange(
  rbdSequence: string,
  knownRBDs: Map<string, string[]>  // RBD fingerprint → known hosts
): HostPrediction[] {
  // Extract k-mer fingerprint of RBD
  const fingerprint = computeKmerFingerprint(rbdSequence, 5);

  // Find similar RBDs in database
  const matches = [];
  for (const [signature, hosts] of knownRBDs) {
    const similarity = jaccardSimilarity(fingerprint, new Set(signature.split(',')));
    if (similarity > 0.3) {
      matches.push({ hosts, similarity });
    }
  }

  // Aggregate predictions
  const hostVotes = new Map<string, { score: number; evidence: string[] }>();
  for (const { hosts, similarity } of matches) {
    for (const host of hosts) {
      const current = hostVotes.get(host) || { score: 0, evidence: [] };
      current.score += similarity;
      current.evidence.push(`RBD similarity: ${(similarity * 100).toFixed(0)}%`);
      hostVotes.set(host, current);
    }
  }

  return Array.from(hostVotes.entries())
    .map(([genus, { score, evidence }]) => ({
      genus,
      confidence: Math.min(1, score / matches.length),
      evidence
    }))
    .sort((a, b) => b.confidence - a.confidence);
}
```

**Structural analysis integration:**
```typescript
interface StructuralRisk {
  residue: number;
  deltaG: number;       // Stability impact
  surfaceArea: number;  // Solvent-exposed area
  charge: number;       // Local electrostatic
  riskScore: number;    // Combined metric
}

async function analyzeStructuralEpitopes(
  pdbId: string | null,
  sequence: string
): Promise<StructuralRisk[]> {
  // Fetch or predict structure
  const structure = pdbId
    ? await fetchPDB(pdbId)
    : await predictWithESMFold(sequence);

  // Run FoldX alanine scan (or approximation)
  const ddgScores = await computeDDG(structure);

  // Compute surface electrostatics
  const electrostatics = await computeAPBS(structure);

  // Combine into per-residue risk
  return sequence.split('').map((_, i) => ({
    residue: i,
    deltaG: ddgScores[i] || 0,
    surfaceArea: structure.residues[i]?.sasa || 0,
    charge: electrostatics[i] || 0,
    riskScore: combineRiskFactors(ddgScores[i], structure.residues[i]?.sasa, electrostatics[i])
  }));
}
```

### Why Good/New
- Bridges sequence to structure-function within a terminal
- **Modular visualization**: See anchor vs shaft vs RBD at a glance
- **Host range prediction**: The holy grail of phage therapy
- **Chimera design hints**: Shows which modules could be swapped
- Combines structural (ΔΔG, electrostatics) with evolutionary (entropy) analysis

### Pedagogical Value: 9/10
Teaches:
- **Receptor-ligand biology**: How phages recognize hosts
- **Protein modularity**: Genes as swappable functional units
- **Information theory**: Shannon entropy as variability measure
- **Structural biology**: Surface exposure, electrostatics, stability
- **Evolution of specificity**: Arms race in molecular detail

### Wow/TUI: Multi-Layer Visualization
```
Tail Fiber Analysis: Lambda gpJ (1132 aa)

Domain structure:
┌──────────────┬────────────────────────────────────┬────────────────────┐
│  N-anchor    │              Shaft                 │        RBD         │
│  (1-80)      │           (81-580)                 │     (581-1132)     │
│   ████████   │  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  │  ░░░▒▒▓▓░░▒▒░░▓▓░  │
│  conserved   │           coiled-coil              │   hypervariable    │
└──────────────┴────────────────────────────────────┴────────────────────┘

Entropy profile:
  4.0 ┤                                           ╭──╮   ╭───╮
  3.0 ┤                                          ╭╯  ╰───╯   ╰╮
  2.0 ┤     ╭────────────────────────────────────╯           │
  1.0 ┤────╯                                                 │
  0.0 ┤                                                      ╰──
      └──────────────────────────────────────────────────────────
        N-anchor              Shaft                    RBD
                                                       ↑ Host specificity

Structural risk (ΔΔG instability):
  High  ┤      ╭╮                                    ╭────╮
  Med   ┤ ─────╯╰─────────────────────────────────────╯    ╰───
  Low   ┤
        └──────────────────────────────────────────────────────
                ↑ Core packing                     ↑ Surface exposed
```

**Host range prediction:**
```
Predicted Hosts for Lambda gpJ RBD:
┌─────────────────┬────────────┬───────────────────────────────────┐
│ Host            │ Confidence │ Evidence                          │
├─────────────────┼────────────┼───────────────────────────────────┤
│ Escherichia     │ ████████░░ │ 95% RBD match to K-12 receptor    │
│ Shigella        │ ██████░░░░ │ 72% Related receptor family       │
│ Salmonella      │ ██░░░░░░░░ │ 15% Weak similarity               │
└─────────────────┴────────────┴───────────────────────────────────┘

Chimera suggestion: Swap RBD (aa 850-1132) with P22 gpJ
  → Predicted new host: Salmonella enterica
```

**3D ASCII model with epitope highlighting:**
```
Tail fiber tip (RBD) - charge/risk mode:

      ╭──────╮
     ╱ ░░▓▓░░ ╲    ▓ = high risk (mutable)
    │  ▓▓████▓▓ │   █ = conserved (essential)
    │  ░░▓▓▓▓░░ │   ░ = neutral
     ╲  ████  ╱
      ╰──────╯
         ↑
    Receptor binding
       surface

[C] Toggle charge mode  [R] Toggle risk mode  [E] Show epitopes
```

## 4) Host Range Predictor via CRISPR/Spacer Matching (Immunity Landscape)

### Concept
CRISPR spacers are **molecular fossils of past infections** — bacterial memory of phage encounters. The global collection represents a map of phage-host evolutionary warfare. By matching phage sequences against spacer databases, we can:
1. **Predict immune hosts**: Which bacteria have defenses against this phage?
2. **Find immunity hotspots**: Which phage regions are most commonly targeted?
3. **Identify vulnerable regions**: Sequences rarely targeted = conserved essentials
4. **Assess therapeutic compatibility**: Will the target bacterium resist this phage?

### Mathematical Foundations

**Approximate string matching:**
```
CRISPR systems tolerate mismatches (typically ≤3) and still provide immunity.
Use edit distance with threshold:

Match if: edit_distance(spacer, target_region) ≤ 3

For efficiency, use k-mer seeding + verification:
  1. Index spacers by k-mers (k=10-12)
  2. Find candidate regions via k-mer hits
  3. Verify with full edit distance
```

**Statistical significance (E-value):**
```
Background probability of k-bp match:
  p_match = (1/4)^k × genome_length

E-value = database_size × query_length × p_match

Significant match if E-value < 0.01
```

**PAM verification:**
```
Different CRISPR-Cas systems require specific PAMs:
  - Cas9 (Type II): NGG at 3' end of protospacer
  - Cas12 (Type V): TTTV at 5' end
  - Type I systems: Various PAMs (AAG, etc.)

Verify PAM presence to reduce false positives.
PAM score = 1.0 (perfect), 0.5 (1 mismatch), 0 (no PAM)
```

**Phylogenetic breadth score:**
```
For matched spacers, record host taxonomy:
  Breadth = number of distinct host genera with immunity

High breadth = phage encountered across diverse bacteria
Low breadth = host-specific targeting
```

**Immunity half-life modeling:**
```
Spacer age approximation:
  - Compare spacer to phage sequence divergence
  - Older spacers have more mismatches
  - Estimate acquisition time from mutation rate

This reveals ongoing vs historical immune relationships.
```

### How to Build

**Efficient k-mer indexing (Rust/WASM):**
```rust
use std::collections::HashMap;

pub struct SpacerIndex {
    kmer_to_spacers: HashMap<u64, Vec<SpacerId>>,
    spacers: Vec<SpacerEntry>,
    k: usize,
}

impl SpacerIndex {
    pub fn new(k: usize) -> Self {
        Self {
            kmer_to_spacers: HashMap::new(),
            spacers: Vec::new(),
            k,
        }
    }

    pub fn add_spacer(&mut self, spacer: SpacerEntry) {
        let id = self.spacers.len();
        for kmer in extract_kmers(&spacer.sequence, self.k) {
            self.kmer_to_spacers
                .entry(kmer)
                .or_insert_with(Vec::new)
                .push(id);
        }
        self.spacers.push(spacer);
    }

    pub fn find_matches(&self, query: &str, max_mismatches: usize) -> Vec<SpacerMatch> {
        let mut candidates: HashMap<SpacerId, usize> = HashMap::new();

        // Phase 1: K-mer filtering
        for kmer in extract_kmers(query, self.k) {
            if let Some(spacer_ids) = self.kmer_to_spacers.get(&kmer) {
                for &id in spacer_ids {
                    *candidates.entry(id).or_insert(0) += 1;
                }
            }
        }

        // Phase 2: Verify candidates with full alignment
        let mut matches = Vec::new();
        for (spacer_id, kmer_hits) in candidates {
            if kmer_hits < 2 { continue; }  // Require multiple k-mer hits

            let spacer = &self.spacers[spacer_id];
            if let Some(dist) = edit_distance_bounded(
                &spacer.sequence,
                query,
                max_mismatches
            ) {
                matches.push(SpacerMatch {
                    spacer_id,
                    mismatches: dist,
                    host_taxonomy: spacer.host_taxonomy.clone(),
                    cas_type: spacer.cas_type.clone(),
                });
            }
        }

        matches
    }
}

fn edit_distance_bounded(a: &str, b: &str, max: usize) -> Option<usize> {
    let a = a.as_bytes();
    let b = b.as_bytes();
    let m = a.len();
    let n = b.len();

    if m.abs_diff(n) > max { return None; }

    let mut prev: Vec<usize> = (0..=n).collect();
    let mut curr = vec![0; n + 1];

    for i in 1..=m {
        curr[0] = i;
        let mut min_val = i;

        for j in 1..=n {
            let cost = if a[i-1] == b[j-1] { 0 } else { 1 };
            curr[j] = (prev[j] + 1)
                .min(curr[j-1] + 1)
                .min(prev[j-1] + cost);
            min_val = min_val.min(curr[j]);
        }

        if min_val > max { return None; }
        std::mem::swap(&mut prev, &mut curr);
    }

    if prev[n] <= max { Some(prev[n]) } else { None }
}
```

**TypeScript orchestration:**
```typescript
interface CRISPRLandscape {
  matches: SpacerMatchResult[];
  immunityHotspots: GenomicRegion[];      // Frequently targeted regions
  vulnerableRegions: GenomicRegion[];     // Rarely targeted (conserved)
  hostDistribution: Map<string, number>;  // Taxonomy -> spacer count
  therapeuticCompatibility: Map<string, CompatibilityScore>;
}

async function analyzeCRISPRImmunity(
  phage: PhageFull,
  sequence: string
): Promise<CRISPRLandscape> {
  // Load pre-built spacer index
  const index = await loadSpacerIndex();

  // Scan genome in windows
  const windowSize = 40;  // Typical spacer length
  const matches: SpacerMatchResult[] = [];

  for (let i = 0; i <= sequence.length - windowSize; i += 10) {
    const window = sequence.slice(i, i + windowSize);
    const windowMatches = index.find_matches(window, 3);

    for (const match of windowMatches) {
      // Verify PAM
      const pamScore = checkPAM(sequence, i, match.casType);
      if (pamScore > 0) {
        matches.push({
          ...match,
          position: i,
          pamScore,
          significance: computeEValue(match, sequence.length)
        });
      }
    }
  }

  // Compute immunity landscape
  return computeLandscape(matches, phage.genes, sequence.length);
}

function computeLandscape(
  matches: SpacerMatchResult[],
  genes: Gene[],
  genomeLength: number
): CRISPRLandscape {
  // Count matches per position (sliding window density)
  const density = new Float32Array(genomeLength);
  for (const match of matches) {
    for (let i = match.position; i < match.position + 40 && i < genomeLength; i++) {
      density[i]++;
    }
  }

  // Find hotspots (high density) and vulnerable regions (zero density)
  const hotspots = findPeaks(density, { threshold: 3, minWidth: 50 });
  const vulnerable = findZeroRegions(density, { minWidth: 200 });

  // Host distribution
  const hostDist = new Map<string, number>();
  for (const match of matches) {
    const genus = match.hostTaxonomy.split(';')[0];
    hostDist.set(genus, (hostDist.get(genus) || 0) + 1);
  }

  return {
    matches,
    immunityHotspots: hotspots.map(h => ({ start: h.start, end: h.end, score: h.peak })),
    vulnerableRegions: vulnerable,
    hostDistribution: hostDist,
    therapeuticCompatibility: computeCompatibility(matches)
  };
}
```

**Data sources:**
- **CRISPRdb**: ~200,000 spacers from complete genomes
- **CRISPRCasdb**: Larger, includes metagenomic data
- **IMG/VR**: Viral metagenome spacers
- Download during build, compress, store in SQLite (~50MB compressed)

### Why Good/New
- **Therapeutic imperative**: Predict which bacteria will resist a candidate phage
- **Ecological insight**: Which phages are "globally experienced" vs novel
- **Conservation analysis**: Rarely targeted regions = essential and conserved
- Host prediction via CRISPR is high-impact; spacer/PAM-aware scoring is richer than plain ANI
- **No other tool integrates CRISPR databases with a genome browser**

### Pedagogical Value: 10/10
Teaches:
- **CRISPR-Cas biology**: Adaptive immunity in bacteria
- **Approximate string matching**: Edit distance, k-mer indexing
- **Host-parasite coevolution**: The molecular arms race
- **Therapeutic considerations**: Why some phages fail
- **Database design**: Efficient indexing for large datasets

### Wow/TUI: Immunity Landscape Navigator
```
CRISPR Immunity Landscape: Lambda phage
═══════════════════════════════════════════════════════════════════════

Position:    0        10k       20k       30k       40k       48k
            ╔════════════════════════════════════════════════════════╗
Density:    ║▓▓▓▓░░░░▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓║
            ╚════════════════════════════════════════════════════════╝
            └─ hotspot ─┘       └─── vulnerable! ───┘   └── hotspot ──┘
                                    (conserved)

Spacers found: 72 total from 28 host species
  Significant (E < 0.01): 48

Host distribution of immunity:
  E. coli         ████████████████████░░░░░░░░░░  42 spacers (58%)
  Salmonella      ████████░░░░░░░░░░░░░░░░░░░░░░  17 spacers (24%)
  Klebsiella      ████░░░░░░░░░░░░░░░░░░░░░░░░░░   8 spacers (11%)
  Shigella        ██░░░░░░░░░░░░░░░░░░░░░░░░░░░░   5 spacers (7%)

Phylogenetic breadth: 4 genera (MODERATE - some cross-immunity expected)
```

**Therapeutic compatibility matrix:**
```
Therapeutic Compatibility: Lambda vs Clinical Isolates

┌────────────────────┬────────────┬─────────────────────────┬──────────┐
│ Strain             │ Resistance │ CRISPR Evidence         │ Predict  │
├────────────────────┼────────────┼─────────────────────────┼──────────┤
│ E. coli MG1655     │ LOW        │ 1 spacer (3 mismatches) │ ✓ Use    │
│ E. coli O157:H7    │ HIGH       │ 4 spacers (0-1 mm)      │ ✗ Avoid  │
│ Salmonella LT2     │ NONE       │ No matching spacers     │ ✓✓ Ideal │
│ Klebsiella ATCC    │ MEDIUM     │ 2 spacers (2 mm each)   │ ? Test   │
└────────────────────┴────────────┴─────────────────────────┴──────────┘

Recommendation: Consider for Salmonella infections (no detected immunity)
                Test carefully against Klebsiella (partial immunity)
                Avoid for O157:H7 (strong immunity, likely resistance)
```

**Detailed spacer alignment view:**
```
Spacer alignment at position 15,420:

Phage:   ATCGATCGATCGATCGATCGATCGATCGATCGATCGATCG-NGG  (PAM)
         |||||||||||||| |||||||||||||||||||||||||||
Spacer:  ATCGATCGATCGAT-GATCGATCGATCGATCGATCGATCG
                      ^ mismatch

Host: Escherichia coli K-12 MG1655
Cas type: Type II-A (Cas9)
PAM: NGG ✓ (canonical)
E-value: 2.3e-12

[Enter] View in context   [N] Next match   [P] Previous match
```

## 5) Codon Economy & tRNA Adaptation Dashboard

### Concept

Translation is not uniform — some codons are translated faster than others. This asymmetry arises because **tRNA abundance varies** by species, and codons decoded by abundant tRNAs are translated efficiently while rare-tRNA codons cause ribosome stalling. Phages must balance two pressures:

1. **Adaptation to host**: Use codons that the host translates quickly for high-expression genes
2. **Temporal regulation**: Some phages deliberately use rare codons to delay expression of late genes

The **Codon Adaptation Index (CAI)** measures how well a gene matches the host's codon preferences. The **tRNA Adaptation Index (tAI)** goes further by modeling actual tRNA-codon interactions including wobble pairing. **Codon Pair Bias (CPB)** reveals that some adjacent codon pairs are systematically avoided — pairs that slow ribosome translocation.

This dashboard quantifies translation efficiency for every gene, enabling:
- Identification of highly expressed genes (high CAI = viral priorities)
- Detection of regulation via codon deoptimization
- Synthetic biology guidance for codon optimization
- Host-switching predictions (will this phage translate well in a new host?)

### Mathematical Foundations

**Codon Adaptation Index (CAI):**
```
For each codon c encoding amino acid a:
  w(c) = f(c) / max(f(c') for all c' encoding a)
  where f(c) = frequency of codon c in highly expressed reference genes

For a gene with codons c₁, c₂, ..., cₙ:
  CAI = exp((1/n) × Σ ln(w(cᵢ)))  // Geometric mean

CAI ranges from 0 to 1:
  CAI ≈ 1.0 = optimal codon usage (highly expressed)
  CAI ≈ 0.3 = poor adaptation (low expression or deoptimized)
```

**tRNA Adaptation Index (tAI):**
```
Accounts for tRNA gene copy number AND wobble pairing efficiency:

For codon c recognized by tRNA anticodons {a₁, a₂, ...}:
  tAI(c) = Σ (1 - sᵢ) × copy_number(aᵢ)

Where sᵢ = wobble penalty:
  - Perfect Watson-Crick: s = 0
  - G:U wobble: s = 0.41
  - I:U/C/A (inosine): s = 0.28
  - Other: s = 0.9-1.0

Gene tAI = geometric mean of per-codon tAI values
```

**Codon Pair Bias (CPB):**
```
Some codon pairs are statistically underrepresented (avoided):

For codon pair (c₁, c₂):
  Expected = f(c₁) × f(c₂) × f(amino_acid_pair)
  Observed = actual count in genome

  CPS(c₁, c₂) = ln(Observed / Expected)  // Codon Pair Score

  CPS < -0.3 = underrepresented (slow translation)
  CPS > +0.3 = overrepresented (fast translation)

Gene CPB = mean CPS over all adjacent codon pairs
```

**Effective Number of Codons (Nc):**
```
Measures codon usage diversity (bias strength):

Nc = 2 + (9/F₂) + (1/F₃) + (5/F₄) + (3/F₆)

Where Fₖ = homozygosity for k-fold degenerate amino acids

Nc ranges from 20 (extreme bias, one codon per aa) to 61 (no bias)
```

### Implementation Approach

**Host tRNA database:**
```typescript
interface HostTRNAProfile {
  hostId: string;
  scientificName: string;
  trnaCopies: Map<string, number>;  // anticodon -> gene copy number
  codonWeights: Map<string, number>;  // codon -> relative adaptedness
  source: 'GtRNAdb' | 'tRNADB-CE' | 'predicted';
}

// Pre-built profiles for common hosts
const HOST_PROFILES: Map<string, HostTRNAProfile> = new Map([
  ['ecoli_k12', { /* E. coli K-12 MG1655 tRNA census */ }],
  ['bacillus_subtilis', { /* B. subtilis 168 */ }],
  ['pseudomonas_syringae', { /* P. syringae DC3000 */ }],
  ['salmonella_typhimurium', { /* S. typhimurium LT2 */ }],
]);

// Load from GtRNAdb (http://gtrnadb.ucsc.edu/)
async function loadTRNAProfile(taxId: string): Promise<HostTRNAProfile> {
  const cached = await db.query('SELECT * FROM trna_profiles WHERE tax_id = ?', [taxId]);
  if (cached) return deserializeProfile(cached);

  // Fetch from GtRNAdb API or bundled data
  const profile = await fetchGtRNAdb(taxId);
  await db.insert('trna_profiles', serializeProfile(profile));
  return profile;
}
```

**CAI calculation:**
```typescript
interface CodonMetrics {
  cai: number;
  tai: number;
  cpb: number;
  nc: number;  // Effective number of codons
  gcContent: number;
  rareCodonPositions: number[];  // Positions with w < 0.2
}

function computeCAI(
  codons: string[],
  weights: Map<string, number>
): number {
  if (codons.length === 0) return 0;

  let logSum = 0;
  let validCodons = 0;

  for (const codon of codons) {
    const w = weights.get(codon);
    if (w && w > 0) {
      logSum += Math.log(w);
      validCodons++;
    }
  }

  if (validCodons === 0) return 0;
  return Math.exp(logSum / validCodons);
}
```

**tAI with wobble rules:**
```typescript
// Wobble pairing efficiency matrix
const WOBBLE_PENALTIES: Record<string, Record<string, number>> = {
  'A': { 'U': 0, 'C': 1, 'G': 1, 'A': 1 },       // Anticodon A pairs with U only
  'G': { 'U': 0.41, 'C': 0, 'G': 1, 'A': 1 },    // G wobbles with U
  'U': { 'U': 1, 'C': 1, 'G': 0, 'A': 0 },       // U pairs with A, G
  'C': { 'U': 1, 'C': 1, 'G': 0, 'A': 1 },       // C pairs with G only
  'I': { 'U': 0.28, 'C': 0.28, 'A': 0.28, 'G': 1 }, // Inosine pairs with U,C,A
};

interface TRNAAnticodon {
  sequence: string;  // e.g., "CAU" for Met
  copyNumber: number;
  wobblePos: number;  // Position 1 (5' of anticodon)
}

function computeTAI(
  codons: string[],
  anticodons: TRNAAnticodon[]
): number {
  const codonTAI = new Map<string, number>();

  // For each codon, sum contributions from all matching anticodons
  for (const codon of getAllCodons()) {
    let totalWeight = 0;

    for (const ac of anticodons) {
      const penalty = computeWobblePenalty(codon, ac.sequence);
      if (penalty < 1) {
        totalWeight += (1 - penalty) * ac.copyNumber;
      }
    }

    codonTAI.set(codon, totalWeight);
  }

  // Normalize
  const maxTAI = Math.max(...codonTAI.values());
  for (const [codon, value] of codonTAI) {
    codonTAI.set(codon, value / maxTAI);
  }

  // Geometric mean for gene
  let logSum = 0;
  for (const codon of codons) {
    const tai = codonTAI.get(codon) || 0.01;
    logSum += Math.log(tai);
  }

  return Math.exp(logSum / codons.length);
}
```

**Codon Pair Bias scoring:**
```typescript
interface CodonPairScores {
  pairScores: Map<string, number>;  // "ATGAAA" -> CPS value
  geneCPB: number;
  slowPairs: { position: number; pair: string; score: number }[];
}

function computeCPB(
  codons: string[],
  referenceFreqs: CodonPairFrequencies
): CodonPairScores {
  const slowPairs: CodonPairScores['slowPairs'] = [];
  let totalCPS = 0;

  for (let i = 0; i < codons.length - 1; i++) {
    const pair = codons[i] + codons[i + 1];
    const cps = referenceFreqs.getCPS(pair);
    totalCPS += cps;

    if (cps < -0.5) {
      slowPairs.push({ position: i, pair, score: cps });
    }
  }

  return {
    pairScores: referenceFreqs.allScores,
    geneCPB: totalCPS / (codons.length - 1),
    slowPairs
  };
}
```

**Per-gene analysis with host switching:**
```typescript
interface GeneTranslationProfile {
  geneId: string;
  geneName: string;
  metrics: Map<string, CodonMetrics>;  // hostId -> metrics
  expressionPrediction: 'high' | 'medium' | 'low';
  regulatoryHints: string[];
}

async function analyzePhageTranslation(
  phage: PhageFull,
  hostIds: string[]
): Promise<GeneTranslationProfile[]> {
  const profiles: GeneTranslationProfile[] = [];

  // Load host profiles
  const hostProfiles = await Promise.all(
    hostIds.map(id => loadTRNAProfile(id))
  );

  for (const gene of phage.genes) {
    const codons = splitIntoCodons(gene.dnaSequence);
    const metricsMap = new Map<string, CodonMetrics>();

    for (const host of hostProfiles) {
      const cai = computeCAI(codons, host.codonWeights);
      const tai = computeTAI(codons, host.anticodons);
      const cpb = computeCPB(codons, host.pairFreqs);
      const nc = computeNc(codons);

      metricsMap.set(host.hostId, {
        cai, tai,
        cpb: cpb.geneCPB,
        nc,
        gcContent: computeGC(gene.dnaSequence),
        rareCodonPositions: findRareCodons(codons, host.codonWeights)
      });
    }

    profiles.push({
      geneId: gene.id,
      geneName: gene.name,
      metrics: metricsMap,
      expressionPrediction: predictExpression(metricsMap),
      regulatoryHints: detectRegulatoryPatterns(codons, metricsMap)
    });
  }

  return profiles;
}
```

### Why This Is a Good Idea

1. **Translational kinetics matter**: Gene expression isn't just about promoters — codon usage determines protein yield. A 10× difference in CAI can mean 10× difference in protein level.

2. **Phage timing secrets**: Why do late genes often have worse CAI than early genes? Deliberate deoptimization creates a temporal delay — codon usage is a regulatory mechanism.

3. **Host range implications**: A phage evolved for E. coli may translate poorly in Pseudomonas due to different tRNA pools. This dashboard predicts host switching success.

4. **Synthetic biology guidance**: Designing optimized phage constructs requires knowing which codons to use. This tool provides the answer immediately.

5. **Rare codon "speed bumps"**: Clusters of rare codons cause ribosome pausing, which can affect protein folding. Identifying these helps understand protein quality issues.

### Innovation Assessment

**Novelty: MEDIUM-HIGH**

CAI calculators exist (CAIcal, EMBOSS), but:
- No integration with genome browser visualization
- No host-switching comparison mode
- No codon pair bias visualization
- No "rare codon heatmap" showing translational speed bumps
- No interactive TUI exploration

### Pedagogical Value: 9/10

Teaches:
- **The genetic code is degenerate but not random**: Synonymous codons have different properties
- **tRNA abundance controls translation speed**: Supply and demand in the ribosome
- **Wobble pairing**: The molecular mechanism behind codon-anticodon flexibility
- **Codon optimization**: Why synthetic biologists care about codon choice
- **Translational regulation**: How phages control gene timing without promoters

### Cool/Wow Factor: 8/10

Seeing a gene light up red because it has poor host adaptation — and then switching to a different host and watching the colors change — makes the concept visceral. The "rare codon speed bumps" view showing translational bottlenecks is genuinely insightful.

### TUI Visualization

```
Codon Economy Dashboard: Lambda phage → E. coli K-12
═══════════════════════════════════════════════════════════════════════════════

Gene Expression Heatmap (CAI):
Gene: ──[N]────[cI]────[cro]───[O]────[P]────[Q]────[gpJ]────[lysis]──
CAI:  ▓▓▓▓▓▓▓▓░░░░░░░░░▓▓▓▓▓▓▓▓░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
      0.82     0.71     0.89    0.68   0.91    0.89   0.93      0.95
      high     med      high    med    high    high   high      high

tAI Overlay (accounting for wobble):
tAI:  ▓▓▓▓▓▓░░░░░░░░░░░▓▓▓▓▓▓▓▓░░░░░░▓▓▓▓▓▓▓░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
                                          ↑
                                   Low tAI despite high CAI
                                   (wobble bottleneck at gpJ)

Legend: ▓▓▓ High (>0.8)  ░░░ Medium (0.5-0.8)  ··· Low (<0.5)

───────────────────────────────────────────────────────────────────────────────

Codon Pair Bias "Speed Bumps" in cI gene:

Sequence:  ATG AAA GAA CTG TTT CGC AGC...
Pair CPS:      +0.2 -0.1 -0.8  +0.1 +0.3
                        ↑
                    SLOW PAIR!
                    (CTG-TTT: CPS = -0.8)

Position:   1   4   7   10  13  16
Speed:     ████████░░░████████████████
                  ↑
            Ribosome pause site

───────────────────────────────────────────────────────────────────────────────

Host Comparison:

                  │ E. coli K-12 │ P. aeruginosa │ B. subtilis │
──────────────────┼──────────────┼───────────────┼─────────────┤
 gpJ (tail fiber) │    0.93      │     0.61 ⚠    │    0.72     │
 cI (repressor)   │    0.71      │     0.69      │    0.58 ⚠   │
 N (antiterminator)│   0.82      │     0.55 ⚠    │    0.67     │
 Overall genome   │    0.84      │     0.63 ⚠    │    0.69     │

⚠ = Poor adaptation (expression may be compromised in this host)

[H] Switch host   [C] Show codon pairs   [R] Show rare codons   [E] Export
```

---

## 6) Temporal Evolution Replay

### Concept

Evolution is not a photograph — it's a **movie**. When we have multiple isolates of related phages collected over time (e.g., longitudinal studies of phage-bacteria coevolution, or historical laboratory stocks), we can reconstruct **how the genome changed through time**.

This feature creates an **animated time-lapse of evolution**, showing:
- When and where each mutation appeared
- How **effective population size (Ne)** changed (population dynamics)
- The **substitution rate** (molecular clock calibration)
- Branches where lineages diverged

The key mathematical tool is the **dated phylogenetic tree** — a tree where branch lengths are calibrated to real time rather than genetic distance. Combined with ancestral sequence reconstruction, we can "play back" evolution.

### Mathematical Foundations

**Molecular Clock Hypothesis:**
```
Substitutions accumulate at a roughly constant rate over time:

  genetic_distance ≈ μ × t × 2  (for two taxa)

Where:
  μ = substitution rate (subs/site/year)
  t = divergence time
  ×2 because both lineages accumulate mutations

For phages: μ ≈ 10⁻⁵ to 10⁻³ subs/site/year
  (much faster than most organisms)
```

**Root-to-tip Regression (clock test):**
```
For each taxon i with sampling date tᵢ:
  dᵢ = genetic distance from root to tip

Linear regression: dᵢ = μ × tᵢ + c

Good clock: R² > 0.8, p < 0.05
Rate: μ = slope
tMRCA = -c / μ  (time to most recent common ancestor)
```

**Least-Squares Dating (LSD2 algorithm):**
```
Given:
  - Unrooted tree T with branch lengths
  - Tip dates {t₁, t₂, ..., tₙ}

Minimize:
  Σᵢⱼ (dᵢⱼ - |tᵢ - tⱼ|×μ)²

Subject to:
  - All internal node dates < descendant dates
  - Molecular clock constraint

Output: Dated tree with internal node dates
```

**Coalescent Skyline (Population Dynamics):**
```
The coalescent relates genealogy to population history:

  E[waiting time for k → k-1 lineages] = Ne × 2 / (k(k-1))

Skyline plot:
  - Estimate Ne at each coalescent interval
  - Piece-wise constant or smooth (skyride)

Bayesian implementation (like BEAST):
  - Prior on Ne trajectory
  - MCMC sampling of trees and parameters
  - Credible intervals on Ne through time
```

**Ancestral Sequence Reconstruction:**
```
For each internal node, infer most likely ancestral sequence:

Maximum Parsimony:
  min Σ changes on tree

Maximum Likelihood (Felsenstein):
  P(node = A) = Σₓ P(left = x | node = A) × P(right = y | node = A) × P(A→x) × P(A→y)

Marginal reconstruction: Most likely state at each position
Joint reconstruction: Most likely complete ancestral sequence
```

### Implementation Approach

**Date parser and standardization:**
```typescript
interface DatedSequence {
  id: string;
  sequence: string;
  collectionDate: Date;
  location?: string;
  metadata?: Record<string, string>;
}

function parseDateFromLabel(label: string): Date | null {
  // Try common formats: YYYY-MM-DD, YYYY-MM, YYYY, DD/MM/YYYY
  const patterns = [
    /(\d{4})-(\d{2})-(\d{2})/,
    /(\d{4})-(\d{2})/,
    /(\d{4})/,
    /(\d{2})\/(\d{2})\/(\d{4})/,
  ];

  for (const pattern of patterns) {
    const match = label.match(pattern);
    if (match) {
      return parseMatchToDate(match, pattern);
    }
  }
  return null;
}
```

**Root-to-tip regression:**
```typescript
interface ClockAnalysis {
  rate: number;          // substitutions/site/year
  rateCI: [number, number];  // 95% CI
  tmrca: Date;           // Time to MRCA
  r2: number;            // Regression fit
  clockLike: boolean;    // Is clock model appropriate?
  residuals: Map<string, number>;  // Per-taxon residuals
}

function analyzeTemporalSignal(
  tree: NewickTree,
  dates: Map<string, Date>
): ClockAnalysis {
  // Get root-to-tip distances
  const distances = computeRootToTipDistances(tree);

  // Convert dates to decimal years
  const decimalDates = new Map<string, number>();
  for (const [id, date] of dates) {
    decimalDates.set(id, dateToDecimal(date));
  }

  // Linear regression
  const points: [number, number][] = [];
  for (const [id, dist] of distances) {
    const date = decimalDates.get(id);
    if (date !== undefined) {
      points.push([date, dist]);
    }
  }

  const { slope, intercept, r2, pValue } = linearRegression(points);

  // Bootstrap CI for rate
  const rateCI = bootstrapCI(points, 1000, 0.95);

  // TMRCA from x-intercept
  const tmrcaDecimal = -intercept / slope;
  const tmrca = decimalToDate(tmrcaDecimal);

  return {
    rate: slope,
    rateCI,
    tmrca,
    r2,
    clockLike: r2 > 0.7 && pValue < 0.05,
    residuals: computeResiduals(points, slope, intercept)
  };
}
```

**Least-Squares Dating (simplified LSD2):**
```typescript
interface DatedTree {
  tree: NewickTree;
  nodeHeights: Map<string, number>;  // Node ID -> date (decimal years)
  rate: number;
  logLikelihood: number;
}

function leastSquaresDating(
  tree: NewickTree,
  tipDates: Map<string, number>,
  outlierRemoval: boolean = true
): DatedTree {
  // Initial rate from root-to-tip regression
  const initialRate = estimateInitialRate(tree, tipDates);

  // Iterative optimization
  let rate = initialRate;
  let nodeHeights = initializeNodeHeights(tree, tipDates, rate);

  for (let iter = 0; iter < 100; iter++) {
    // Update node heights given rate
    nodeHeights = optimizeNodeHeights(tree, tipDates, rate);

    // Update rate given node heights
    const newRate = optimizeRate(tree, nodeHeights);

    if (Math.abs(newRate - rate) < 1e-10) break;
    rate = newRate;
  }

  // Remove outliers and reoptimize if requested
  if (outlierRemoval) {
    const outliers = detectOutliers(tree, nodeHeights, tipDates, rate);
    if (outliers.length > 0) {
      return leastSquaresDating(
        pruneTree(tree, outliers),
        tipDates,
        false
      );
    }
  }

  return {
    tree: relabelWithDates(tree, nodeHeights),
    nodeHeights,
    rate,
    logLikelihood: computeLogLikelihood(tree, nodeHeights, rate)
  };
}
```

**Ancestral sequence reconstruction:**
```typescript
interface AncestralReconstruction {
  nodeSequences: Map<string, string>;
  mutations: MutationEvent[];
  confidence: Map<string, Float32Array>;  // Per-position confidence
}

interface MutationEvent {
  position: number;
  ancestral: string;
  derived: string;
  branch: { parent: string; child: string };
  branchTime: number;  // When on the branch (0 = at parent, 1 = at child)
}

function reconstructAncestralSequences(
  tree: DatedTree,
  tipSequences: Map<string, string>,
  model: SubstitutionModel = 'JC69'
): AncestralReconstruction {
  const nodeSequences = new Map<string, string>();
  const mutations: MutationEvent[] = [];
  const seqLength = tipSequences.values().next().value.length;

  // Copy tip sequences
  for (const [id, seq] of tipSequences) {
    nodeSequences.set(id, seq);
  }

  // Post-order traversal: compute partial likelihoods
  const partials = new Map<string, Float32Array[]>();
  traversePostOrder(tree.tree, (node) => {
    if (isLeaf(node)) {
      partials.set(node.id, sequenceToPartials(tipSequences.get(node.id)!));
    } else {
      partials.set(node.id, combinePartials(
        partials.get(node.left.id)!,
        partials.get(node.right.id)!,
        node.leftDist,
        node.rightDist,
        model
      ));
    }
  });

  // Pre-order traversal: reconstruct sequences
  traversePreOrder(tree.tree, (node, parent) => {
    if (!isLeaf(node)) {
      const ancestral = reconstructNodeSequence(
        partials.get(node.id)!,
        parent ? partials.get(parent.id)! : null,
        model
      );
      nodeSequences.set(node.id, ancestral);
    }

    // Record mutations on this branch
    if (parent) {
      const parentSeq = nodeSequences.get(parent.id)!;
      const childSeq = nodeSequences.get(node.id)!;

      for (let pos = 0; pos < seqLength; pos++) {
        if (parentSeq[pos] !== childSeq[pos]) {
          mutations.push({
            position: pos,
            ancestral: parentSeq[pos],
            derived: childSeq[pos],
            branch: { parent: parent.id, child: node.id },
            branchTime: estimateMutationTime(/* ... */)
          });
        }
      }
    }
  });

  return { nodeSequences, mutations, confidence: computeConfidence(partials) };
}
```

**Skyline population dynamics:**
```typescript
interface SkylineResult {
  timePoints: number[];       // Time axis (years before present)
  ne: number[];               // Effective population size estimates
  neLower: number[];          // 95% CI lower bound
  neUpper: number[];          // 95% CI upper bound
  events: CoalescentEvent[];  // When lineages merged
}

function computeSkyline(datedTree: DatedTree): SkylineResult {
  // Extract coalescent times (internal node heights)
  const coalTimes = getCoalescentTimes(datedTree);

  // Sort by time (most recent first)
  coalTimes.sort((a, b) => b.time - a.time);

  // Classic skyline: one Ne per coalescent interval
  const timePoints: number[] = [];
  const ne: number[] = [];

  let k = datedTree.tree.leafCount;  // Current lineage count

  for (let i = 0; i < coalTimes.length; i++) {
    const interval = i === 0
      ? coalTimes[0].time
      : coalTimes[i].time - coalTimes[i - 1].time;

    // Ne = k(k-1) × interval / 2
    const neEstimate = k * (k - 1) * interval / 2;

    timePoints.push(coalTimes[i].time);
    ne.push(neEstimate);

    k--;  // One coalescence reduces lineage count
  }

  // Smooth with generalized skyline (group intervals)
  return smoothSkyline({ timePoints, ne, neLower: [], neUpper: [], events: coalTimes });
}
```

**Animation frame generator:**
```typescript
interface EvolutionFrame {
  time: number;  // Decimal year
  displayDate: string;
  sequence: string;
  mutations: { position: number; from: string; to: string }[];
  activeBranches: string[];  // Branches "alive" at this time
  neAtTime: number;
  cumulativeMutations: number;
}

function* generateEvolutionFrames(
  reconstruction: AncestralReconstruction,
  datedTree: DatedTree,
  skyline: SkylineResult,
  fps: number = 10
): Generator<EvolutionFrame> {
  const tmrca = Math.min(...datedTree.nodeHeights.values());
  const present = Math.max(...datedTree.nodeHeights.values());
  const duration = present - tmrca;

  const frameCount = Math.ceil(duration * fps);
  const dt = duration / frameCount;

  let currentSequence = reconstruction.nodeSequences.get(datedTree.tree.root.id)!;
  let cumulativeMutations = 0;

  for (let frame = 0; frame <= frameCount; frame++) {
    const time = tmrca + frame * dt;

    // Find mutations that occurred in this time slice
    const frameMutations = reconstruction.mutations.filter(m => {
      const parentTime = datedTree.nodeHeights.get(m.branch.parent)!;
      const childTime = datedTree.nodeHeights.get(m.branch.child)!;
      const mutTime = parentTime + (childTime - parentTime) * m.branchTime;
      return mutTime >= time - dt && mutTime < time;
    });

    // Apply mutations to sequence
    for (const mut of frameMutations) {
      currentSequence =
        currentSequence.slice(0, mut.position) +
        mut.derived +
        currentSequence.slice(mut.position + 1);
      cumulativeMutations++;
    }

    // Find active branches at this time
    const activeBranches = findActiveBranches(datedTree, time);

    // Interpolate Ne
    const neAtTime = interpolateNe(skyline, time);

    yield {
      time,
      displayDate: decimalToDate(time).toISOString().split('T')[0],
      sequence: currentSequence,
      mutations: frameMutations.map(m => ({
        position: m.position,
        from: m.ancestral,
        to: m.derived
      })),
      activeBranches,
      neAtTime,
      cumulativeMutations
    };
  }
}
```

### Why This Is a Good Idea

1. **Time is the hidden dimension**: Most tools show genetic distance, not time. But biologists think in years, generations, and experimental timelines.

2. **Coevolution studies**: Phage-bacteria arms races occur over weeks to months. Watching evolution unfold reveals the dynamics that static views miss.

3. **Outbreak forensics**: For phage therapy monitoring, knowing *when* resistance mutations arose helps understand failure modes.

4. **Educational power**: Nothing conveys "evolution is ongoing" like watching mutations accumulate in real-time.

5. **Population dynamics**: The Ne skyline reveals population crashes (bottlenecks) and expansions — the demographic history of the phage.

### Innovation Assessment

**Novelty: HIGH**

Time-tree tools exist (BEAST, TreeTime, LSD2), but:
- No interactive animated visualization
- No integration with genome browser
- No TUI implementation
- "Time scrubber" interface is completely novel

### Pedagogical Value: 10/10

Teaches:
- **Molecular clocks**: The concept that mutations tick like a clock
- **Phylogenetic dating**: How we calibrate trees to real time
- **Coalescent theory**: How genealogies encode population history
- **Ancestral reconstruction**: Inferring the past from the present
- **Population dynamics**: Ne as a proxy for ecological success

### Cool/Wow Factor: 10/10

Watching mutations appear one by one as the timeline advances — seeing the "ghost" of the ancestral sequence transform into the modern isolate — is genuinely mesmerizing. The Ne skyline pulsing as the population expands and contracts adds another dimension.

### TUI Visualization

```
Temporal Evolution Replay: Lambda isolates (1950-2020)
═══════════════════════════════════════════════════════════════════════════════

Time: ████████████████░░░░░░░░░░░░░░  1985-03-12
      1950                     2020

Tree (branches alive highlighted):
                    ┌──● Lambda-1950 (ancestor)
                ┌───┤
            ┌───┤   └──○ Lambda-1962
        ┌───┤   │
        │   │   └──────○ Lambda-1975
    ────┤   │
        │   └──────────● Lambda-1985 ← YOU ARE HERE
        │
        └──────────────────○ Lambda-2020 (future)

Sequence at 1985-03-12:
Position:  12450  12451  12452  12453  12454  12455  12456  12457
Ancestral:   A      T      G      C      A      T      G      G
Current:     A      T      C*     C      A      T      G      G
                    ↑
              MUTATION!
              G→C (1983-08-21)
              Gene: cI (repressor)

───────────────────────────────────────────────────────────────────────────────

Mutation Timeline:
     ╭─[G12452C]──[A3891T]──[T28103C]─────────────────────────╮
1950 ┼──────○────────○──────────○──────────────────────────────┤ 2020
     1953      1971       1983                                 │
                                                               │
Cumulative mutations: 47/152 (31%)                             │
Rate: 2.1×10⁻⁴ subs/site/year                                  │

───────────────────────────────────────────────────────────────────────────────

Effective Population Size (Ne):
       10⁶ ┤
           │    ╭──────╮
       10⁵ ┤    │      ╰──╮                ╭──────────╮
           │────╯         ╰────────────────╯          ╰────────
       10⁴ ┤                    ▲
           │              Population crash
       10³ ┼─────────────────────────────────────────────────────
           1950         1970         1990         2010      2020
                                    ↑
                              Current time

[Space] Play/Pause  [←/→] Step  [+/-] Speed  [R] Reset  [ESC] Exit
```

---

## 7) Protein Domain Chord Plot

### Concept

Phage proteomes are **modular mosaics** — built from shuffled and recombined functional domains. The same DNA-binding domain might appear in the repressor of one phage and the anti-repressor of another. The same tail fiber receptor-binding domain might be swapped between distant phages to change host range.

A **chord diagram** visualizes these domain-sharing relationships as arcs connecting phages. Each arc represents a shared domain, with thickness proportional to copy number or sequence identity. The result reveals:
- **Core domains**: Present in all phages (structural essentials)
- **Accessory domains**: Patchy distribution (niche adaptation)
- **Domain promiscuity**: Domains that appear in unexpected combinations
- **Convergent evolution**: Same domain, independent acquisitions

### Mathematical Foundations

**Domain Detection via HMM profiles:**
```
HMMER3 hmmscan workflow:
  1. Query each protein against Pfam-A HMM database
  2. For each domain hit:
     - E-value < 1e-5 (significant)
     - Coverage > 60% of HMM model
     - No envelope overlap with higher-scoring hits

Output: domain annotations with:
  - Pfam accession (PF00000)
  - Domain name (e.g., "HTH_3" = helix-turn-helix type 3)
  - Start/end positions in protein
  - Bit score and E-value
  - Clan membership (superfamily)
```

**Domain occurrence matrix:**
```
Let D = {d₁, d₂, ..., dₘ} be all detected domains
Let P = {p₁, p₂, ..., pₙ} be all phages

Occurrence matrix O[m × n]:
  O[i,j] = count of domain dᵢ in phage pⱼ

Presence/absence matrix B[m × n]:
  B[i,j] = 1 if O[i,j] > 0, else 0
```

**Domain co-occurrence (for clustering):**
```
Jaccard similarity between domains:
  J(dᵢ, dⱼ) = |phages with both| / |phages with either|

Domains with high Jaccard often function together.
Cluster with MCL (Markov Cluster Algorithm) to find domain modules.
```

**Chord diagram layout:**
```
Phages arranged on a circle (0 to 2π)
  θᵢ = 2π × i / n

For each shared domain connecting phages pᵢ and pⱼ:
  Draw Bezier curve from θᵢ to θⱼ
  Control points at circle center (creates arc shape)

Arc thickness proportional to:
  - Number of shared domain copies
  - Or sequence identity of the domain instances
```

### Implementation Approach

**HMMER wrapper (offline preprocessing):**
```typescript
interface DomainHit {
  pfamId: string;
  pfamName: string;
  clanId?: string;
  proteinId: string;
  phageId: number;
  start: number;
  end: number;
  score: number;
  eValue: number;
  description: string;
}

// Run during database build (requires hmmscan installed)
async function scanProteinsForDomains(
  proteins: Protein[],
  pfamPath: string
): Promise<DomainHit[]> {
  // Write proteins to FASTA
  const fastaPath = await writeTempFasta(proteins);

  // Run hmmscan
  const result = await exec(
    `hmmscan --domtblout /dev/stdout -E 1e-5 ${pfamPath}/Pfam-A.hmm ${fastaPath}`
  );

  // Parse domtblout format
  return parseDomtblout(result.stdout);
}

// Store in SQLite for fast TUI access
async function storeDomainAnnotations(hits: DomainHit[]): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS domain_hits (
      id INTEGER PRIMARY KEY,
      pfam_id TEXT NOT NULL,
      pfam_name TEXT NOT NULL,
      clan_id TEXT,
      protein_id TEXT NOT NULL,
      phage_id INTEGER NOT NULL,
      start INTEGER,
      end INTEGER,
      score REAL,
      e_value REAL,
      FOREIGN KEY (phage_id) REFERENCES phages(id)
    )
  `);

  await db.insertBatch('domain_hits', hits);
}
```

**Domain sharing computation:**
```typescript
interface DomainSharing {
  domain: string;
  phageA: number;
  phageB: number;
  copiesA: number;
  copiesB: number;
  averageIdentity: number;  // Sequence identity between instances
}

async function computeDomainSharing(
  phageIds: number[]
): Promise<DomainSharing[]> {
  // Get domain presence per phage
  const domainsByPhage = new Map<number, Map<string, DomainHit[]>>();

  for (const phageId of phageIds) {
    const hits = await db.query(
      'SELECT * FROM domain_hits WHERE phage_id = ?',
      [phageId]
    );

    const byDomain = new Map<string, DomainHit[]>();
    for (const hit of hits) {
      const list = byDomain.get(hit.pfamId) || [];
      list.push(hit);
      byDomain.set(hit.pfamId, list);
    }
    domainsByPhage.set(phageId, byDomain);
  }

  // Find all pairwise sharings
  const sharings: DomainSharing[] = [];

  for (let i = 0; i < phageIds.length; i++) {
    for (let j = i + 1; j < phageIds.length; j++) {
      const domainsA = domainsByPhage.get(phageIds[i])!;
      const domainsB = domainsByPhage.get(phageIds[j])!;

      for (const [domain, hitsA] of domainsA) {
        const hitsB = domainsB.get(domain);
        if (hitsB) {
          sharings.push({
            domain,
            phageA: phageIds[i],
            phageB: phageIds[j],
            copiesA: hitsA.length,
            copiesB: hitsB.length,
            averageIdentity: await computeAverageIdentity(hitsA, hitsB)
          });
        }
      }
    }
  }

  return sharings;
}
```

**MCL clustering for domain modules:**
```typescript
interface DomainCluster {
  id: number;
  domains: string[];
  name: string;  // Inferred function
  phageCount: number;
}

function clusterDomains(
  occurrenceMatrix: number[][],
  domainNames: string[],
  inflation: number = 2.0
): DomainCluster[] {
  // Build adjacency matrix from co-occurrence
  const n = domainNames.length;
  const adj = Array(n).fill(0).map(() => Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      adj[i][j] = jaccardSimilarity(
        occurrenceMatrix[i],
        occurrenceMatrix[j]
      );
    }
  }

  // MCL iterations
  let matrix = normalizeColumns(adj);
  for (let iter = 0; iter < 100; iter++) {
    matrix = expand(matrix);  // Matrix multiplication
    matrix = inflate(matrix, inflation);  // Element-wise power + normalize
    if (hasConverged(matrix)) break;
  }

  // Extract clusters from converged matrix
  return extractClusters(matrix, domainNames);
}
```

**ASCII chord diagram renderer:**
```typescript
interface ChordDiagram {
  nodes: { phage: string; angle: number; arcLength: number }[];
  chords: {
    source: number;
    target: number;
    width: number;
    domain: string;
    color: string;
  }[];
}

function renderChordDiagram(
  diagram: ChordDiagram,
  width: number,
  height: number
): string[] {
  const lines: string[] = Array(height).fill('').map(() => ' '.repeat(width));
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 2;

  // Draw outer ring with phage names
  for (const node of diagram.nodes) {
    const x = Math.round(cx + radius * Math.cos(node.angle));
    const y = Math.round(cy + radius * Math.sin(node.angle));
    // Place phage label
    placeText(lines, x, y, node.phage);
  }

  // Draw chords using Braille patterns for smooth curves
  for (const chord of diagram.chords) {
    const sourceAngle = diagram.nodes[chord.source].angle;
    const targetAngle = diagram.nodes[chord.target].angle;

    // Bezier curve through center
    for (let t = 0; t <= 1; t += 0.02) {
      const x = bezierX(sourceAngle, targetAngle, radius, cx, t);
      const y = bezierY(sourceAngle, targetAngle, radius, cy, t);
      placeBraillePoint(lines, x, y);
    }
  }

  return lines;
}

// Braille character mapping (2x4 dots per character cell)
function placeBraillePoint(lines: string[], x: number, y: number): void {
  const charX = Math.floor(x / 2);
  const charY = Math.floor(y / 4);
  const dotX = x % 2;
  const dotY = y % 4;

  const brailleOffset = 0x2800;
  const dotBit = BRAILLE_DOT_MAP[dotY][dotX];

  // Get current character, add new dot
  const currentCode = lines[charY].charCodeAt(charX);
  const newCode = (currentCode >= brailleOffset && currentCode < brailleOffset + 256)
    ? currentCode | dotBit
    : brailleOffset | dotBit;

  lines[charY] = lines[charY].slice(0, charX) +
                 String.fromCharCode(newCode) +
                 lines[charY].slice(charX + 1);
}
```

### Why This Is a Good Idea

1. **Domain-level evolution**: Genes evolve, but domains are the truly modular units. Seeing domain sharing reveals deeper evolutionary relationships than gene-level analysis.

2. **Function transfer mechanism**: Understanding which domains are shared helps predict how functions spread through phage populations.

3. **Protein engineering hints**: Knowing that domain X appears with domain Y in multiple phages suggests they may function together.

4. **Beautiful data reduction**: Thousands of genes → dozens of domains → one elegant visualization.

5. **Novel TUI visualization**: Chord diagrams in terminals are rare; this pushes ASCII art boundaries.

### Innovation Assessment

**Novelty: HIGH**

Chord diagrams exist for genomic data (Circos), but:
- No TUI implementation exists
- ASCII/Braille curve rendering is novel
- Interactive domain filtering is new
- Integration with genome browser unique

### Pedagogical Value: 9/10

Teaches:
- **Protein domains**: The building blocks of proteins
- **HMM profiles**: How we detect homology without alignment
- **Modular evolution**: Genes are assembled from domains
- **Network visualization**: Representing relationships visually

### Cool/Wow Factor: 9/10

Seeing smooth curves drawn in Braille characters — connecting distant phages through shared domains — is visually stunning. The interactivity (filter by domain family, highlight on hover) makes exploration addictive.

### TUI Visualization

```
Protein Domain Chord Plot: Lambda + T4 + T7 + P22 + Phi29
═══════════════════════════════════════════════════════════════════════════════

              Lambda
                ╱╲
              ╱    ╲
           ⡠⠊      ⠑⡄
         ⡰⠁          ⠑⡄
       ⡠⠃              ⠘⡄
      ⡜                  ⠘⡄           Selected: HTH_3 (Helix-turn-helix)
    ⡰⠁                    ⠑⡄           Found in: Lambda (cI), P22 (c2)
   ⡜                        ⠘⡄          Function: DNA-binding repressor
  ⡜                          ⠘⡄
 ⡔    T4                 P22   ⠢⡀
⡎      ⠑⢄                ⡠⠊      ⠱⡀
⡇        ⠑⢄            ⡠⠊        ⠱⡀
⡇          ⠑⢄        ⡠⠊          ⢱
⡇            ⠑⢄    ⡠⠊            ⢱
⡇              ⠑⢄⡠⠊              ⢱
⠘⡄              ⡜               ⡰⠁
 ⠘⡄            ⡜               ⡰⠁
  ⠘⡄          ⡜               ⡰⠁
   ⠑⡄        ⡜              ⡰⠁
    ⠑⡄      ⡜   Phi29     ⡠⠊
     ⠑⡄    ⡜            ⡠⠊
       ⠑⡄⡰⠁          ⡠⠊
         ⠱⡀        ⡠⠊
           T7───────⠁

───────────────────────────────────────────────────────────────────────────────

Domain Summary:
┌─────────────┬──────────────────────────────────────────────────────────────┐
│ Domain      │ Phages                           │ Copies │ Function        │
├─────────────┼──────────────────────────────────────────────────────────────┤
│ Phage_cap_E │ Lambda, T4, T7, P22, Phi29       │   8    │ Capsid protein  │
│ HTH_3       │ Lambda, P22                      │   2    │ DNA binding     │
│ Phage_tail  │ Lambda, T4, P22                  │   12   │ Tail structure  │
│ DNA_pol_B   │ T4, T7, Phi29                    │   3    │ DNA replication │
│ Peptidase_M │ Lambda, T4, T7, P22              │   4    │ Lysis           │
└─────────────┴──────────────────────────────────────────────────────────────┘

Legend: ━ Core (all phages)  ─ Common (3-4)  ╌ Rare (2)

[Tab] Cycle domains  [Enter] Show alignment  [F] Filter by clan  [ESC] Exit
```

---

## 8) Phage-Defense Arms Race Scanner

### Concept

Bacteria and phages are locked in an **eternal arms race**. Bacteria evolve elaborate defense systems — CRISPR-Cas, restriction-modification (RM), abortive infection (Abi), retrons, and more. Phages counter with anti-defense genes — anti-CRISPRs, methyltransferases that evade RM, Abi inhibitors, and other molecular countermeasures.

This scanner identifies both sides of the battle:
1. **Phage offense**: What anti-defense genes does this phage carry?
2. **Host defense** (if known): What systems protect the host?
3. **Matchup prediction**: Which defenses is this phage equipped to overcome?

The result is a "combat readiness" profile showing the phage's arsenal against the known bacterial defense landscape.

### Mathematical Foundations

**HMM profile scoring for anti-defense genes:**
```
For each anti-defense family F (e.g., AcrIF, Ocr, Dam):
  - Curated HMM profile from literature
  - Score each phage protein against profile
  - E-value < 1e-5 = significant hit

Confidence scoring:
  - Bit score vs. trusted cutoff (TC)
  - Score > TC = high confidence
  - Score > noise cutoff (NC) = medium confidence
  - Score < NC = low confidence / spurious
```

**Defense system detection in hosts:**
```
For bacterial genomes, detect:
  - CRISPR arrays: CRT/PILER-CR detection
  - Cas proteins: Cas-typing via CasTyper profiles
  - RM systems: REBASE profiles
  - Abi systems: Abi-specific HMMs
  - Retrons: RT + ncRNA prediction

Create defense profile D = {d₁, d₂, ..., dₙ}
```

**Offense-Defense compatibility matrix:**
```
Known interactions (from literature):
  M[offense, defense] =
    +1 if offense neutralizes defense
    -1 if defense blocks phage (no counter)
     0 if no known interaction

Phage "escape score" vs host:
  S = Σᵢ M[phage_offense_i, host_defense_j] / |host_defenses|

S > 0.5: Phage likely to infect
S < 0: Phage likely blocked
```

**Anti-defense gene catalog:**
```
Major families:
  Anti-CRISPR:
    - AcrIF (Inhibits Cas3/Cas10)
    - AcrIIA (Inhibits Cas9)
    - AcrIE (Inhibits Type I-E)
    - AcrVA (Inhibits Cas12a)

  Anti-RM:
    - Dam/Dcm methyltransferases (pre-methylate DNA)
    - Ocr (T7 protein that mimics DNA)
    - DarB (blocks EcoKI restriction)

  Anti-Abi:
    - Gene-specific inhibitors (often poorly characterized)

  Anti-Retron:
    - Recently discovered (2020+)

  Other:
    - dGTPase inhibitors
    - SOS response suppressors
```

### Implementation Approach

**Anti-defense HMM database:**
```typescript
interface AntiDefenseProfile {
  id: string;
  name: string;
  targetDefense: string;
  mechanism: string;
  hmmPath: string;
  trustedCutoff: number;
  noiseCutoff: number;
  references: string[];
}

// Curated profiles bundled with app
const ANTI_DEFENSE_PROFILES: AntiDefenseProfile[] = [
  {
    id: 'AcrIF1',
    name: 'Anti-CRISPR AcrIF1',
    targetDefense: 'CRISPR-Cas Type I-F',
    mechanism: 'Binds Cas3 helicase, blocks DNA degradation',
    hmmPath: 'profiles/AcrIF1.hmm',
    trustedCutoff: 25.0,
    noiseCutoff: 15.0,
    references: ['Bondy-Denomy 2013']
  },
  {
    id: 'Ocr',
    name: 'T7 Ocr (Overcome Classical Restriction)',
    targetDefense: 'Type I RM (EcoKI)',
    mechanism: 'DNA mimic, sequesters EcoKI enzyme',
    hmmPath: 'profiles/Ocr.hmm',
    trustedCutoff: 40.0,
    noiseCutoff: 25.0,
    references: ['Walkinshaw 2002']
  },
  // ... more profiles
];

async function scanForAntiDefense(
  proteins: Protein[]
): Promise<AntiDefenseHit[]> {
  const hits: AntiDefenseHit[] = [];

  for (const profile of ANTI_DEFENSE_PROFILES) {
    const results = await runHmmscan(proteins, profile.hmmPath);

    for (const result of results) {
      if (result.score >= profile.noiseCutoff) {
        hits.push({
          proteinId: result.proteinId,
          antiDefenseId: profile.id,
          antiDefenseName: profile.name,
          targetDefense: profile.targetDefense,
          mechanism: profile.mechanism,
          score: result.score,
          confidence: result.score >= profile.trustedCutoff ? 'high' : 'medium',
          eValue: result.eValue
        });
      }
    }
  }

  return hits;
}
```

**Host defense profiling:**
```typescript
interface HostDefenseProfile {
  hostId: string;
  defenses: DefenseSystem[];
  vulnerabilities: string[];  // Defenses lacking known inhibitors
}

interface DefenseSystem {
  type: 'CRISPR' | 'RM' | 'Abi' | 'Retron' | 'CBASS' | 'Thoeris' | 'Other';
  subtype: string;  // e.g., 'Type I-E', 'Type IIG'
  genes: string[];
  spacerCount?: number;  // For CRISPR
  recognitionSite?: string;  // For RM
  confidence: number;
}

async function profileHostDefenses(
  hostGenome: string,
  hostAnnotation: GeneAnnotation[]
): Promise<HostDefenseProfile> {
  const defenses: DefenseSystem[] = [];

  // Detect CRISPR-Cas
  const crisprArrays = detectCRISPRArrays(hostGenome);
  const casGenes = await detectCasGenes(hostAnnotation);
  if (casGenes.length > 0) {
    const casType = typeCasSystem(casGenes);
    defenses.push({
      type: 'CRISPR',
      subtype: casType,
      genes: casGenes.map(g => g.name),
      spacerCount: crisprArrays.reduce((sum, arr) => sum + arr.spacers.length, 0),
      confidence: 0.95
    });
  }

  // Detect RM systems
  const rmGenes = await detectRMSystems(hostAnnotation);
  for (const rm of rmGenes) {
    defenses.push({
      type: 'RM',
      subtype: rm.type,
      genes: [rm.methylase, rm.endonuclease].filter(Boolean),
      recognitionSite: rm.recognitionSequence,
      confidence: rm.confidence
    });
  }

  // Detect Abi systems (harder - often unannotated)
  const abiGenes = await detectAbiSystems(hostAnnotation);
  for (const abi of abiGenes) {
    defenses.push({
      type: 'Abi',
      subtype: abi.family,
      genes: [abi.geneName],
      confidence: abi.confidence
    });
  }

  return {
    hostId: hostGenome.id,
    defenses,
    vulnerabilities: identifyVulnerabilities(defenses)
  };
}
```

**Matchup computation:**
```typescript
interface ArmsRaceMatchup {
  phageId: number;
  hostId: string;
  phageOffense: AntiDefenseHit[];
  hostDefense: DefenseSystem[];
  neutralizedDefenses: { defense: DefenseSystem; by: AntiDefenseHit }[];
  activeDefenses: DefenseSystem[];
  escapeScore: number;  // -1 to +1
  prediction: 'likely_infects' | 'uncertain' | 'likely_blocked';
}

function computeMatchup(
  phageOffense: AntiDefenseHit[],
  hostDefense: HostDefenseProfile
): ArmsRaceMatchup {
  const neutralized: ArmsRaceMatchup['neutralizedDefenses'] = [];
  const active: DefenseSystem[] = [];

  for (const defense of hostDefense.defenses) {
    // Find anti-defense that targets this system
    const counter = phageOffense.find(o =>
      o.targetDefense.includes(defense.type) ||
      o.targetDefense.includes(defense.subtype)
    );

    if (counter && counter.confidence === 'high') {
      neutralized.push({ defense, by: counter });
    } else {
      active.push(defense);
    }
  }

  // Compute escape score
  const totalDefenses = hostDefense.defenses.length;
  const neutralizedCount = neutralized.length;
  const escapeScore = totalDefenses > 0
    ? (neutralizedCount - active.length) / totalDefenses
    : 0;

  return {
    phageId: 0,  // Set by caller
    hostId: hostDefense.hostId,
    phageOffense,
    hostDefense: hostDefense.defenses,
    neutralizedDefenses: neutralized,
    activeDefenses: active,
    escapeScore,
    prediction: escapeScore > 0.3 ? 'likely_infects'
              : escapeScore < -0.3 ? 'likely_blocked'
              : 'uncertain'
  };
}
```

### Why This Is a Good Idea

1. **Therapeutic selection**: For phage therapy, you need phages that can overcome the target pathogen's defenses. This tool predicts which phage-host combinations will work.

2. **Evolutionary insight**: Anti-defense genes are hotspots of phage-bacteria coevolution. Identifying them reveals evolutionary arms race dynamics.

3. **Defense landscape mapping**: Understanding what defenses a host has helps predict susceptibility to phage infection.

4. **Discovery catalyst**: Unknown genes adjacent to known anti-defense genes may themselves be novel countermeasures.

5. **No existing tool**: Defense-Anti-Defense pairing is done manually; no tool integrates both sides.

### Innovation Assessment

**Novelty: HIGH**

Tools exist for CRISPR (CRISPRCasFinder), RM (REBASE), and anti-CRISPR (AcrFinder) detection separately, but:
- No tool integrates all defense types
- No "matchup" prediction exists
- TUI visualization of arms race is completely novel
- Combat readiness scores are new

### Pedagogical Value: 10/10

Teaches:
- **CRISPR-Cas systems**: The bacterial immune system
- **Restriction-Modification**: The original anti-viral defense
- **Abortive infection**: Altruistic death to stop infection
- **Anti-CRISPRs**: How phages fight back
- **Coevolution**: The Red Queen's race in microbiology

### Cool/Wow Factor: 9/10

Seeing a phage's "combat loadout" against a host's "defense grid" — complete with matches and mismatches highlighted — makes molecular warfare tangible. The prediction ("likely infects" vs "likely blocked") adds real-world utility.

### TUI Visualization

```
Phage-Defense Arms Race: T4 vs E. coli K-12
═══════════════════════════════════════════════════════════════════════════════

PHAGE OFFENSE                          HOST DEFENSE
(Anti-defense arsenal)                 (Immune systems)

┌─────────────────────────┐            ┌─────────────────────────┐
│ ⚔ Dam methyltransferase │───────────▶│ ⛡ EcoKI (Type I RM)    │ ✓ BLOCKED
│   Confidence: ████████░░│            │   Recognition: AACNNNNNNGTGC
│   Mechanism: Pre-        │            │   Status: NEUTRALIZED   │
│   methylates GATC sites  │            │                         │
└─────────────────────────┘            └─────────────────────────┘

┌─────────────────────────┐            ┌─────────────────────────┐
│ ⚔ ModA (Alt-like)       │───────────▶│ ⛡ EcoRV (Type II RM)   │ ✓ BLOCKED
│   Confidence: ███████░░░│            │   Recognition: GATATC   │
│   Mechanism: DNA         │            │   Status: NEUTRALIZED   │
│   modification           │            │                         │
└─────────────────────────┘            └─────────────────────────┘

┌─────────────────────────┐            ┌─────────────────────────┐
│ ⚔ Arn (anti-Rex)        │───────────▶│ ⛡ Rex (Abi system)     │ ✓ BLOCKED
│   Confidence: ██████░░░░│            │   Type: Rex A/B         │
│   Mechanism: Sequesters  │            │   Status: NEUTRALIZED   │
│   RexB membrane protein  │            │                         │
└─────────────────────────┘            └─────────────────────────┘

                    ╳                  ┌─────────────────────────┐
       NO COUNTER FOUND ◀──────────────│ ⛡ CRISPR-Cas I-E       │ ⚠ ACTIVE
                                       │   Spacers: 12 (2 match) │
                                       │   Status: THREAT!       │
                                       └─────────────────────────┘

───────────────────────────────────────────────────────────────────────────────

BATTLE ASSESSMENT
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  Defenses neutralized:  3/4 (75%)                                           │
│  Active threats:        1 (CRISPR-Cas I-E with matching spacers)            │
│                                                                              │
│  Escape Score: ████████░░ +0.50                                             │
│                                                                              │
│  Prediction: UNCERTAIN ⚠                                                    │
│                                                                              │
│  Notes:                                                                      │
│  - T4 lacks anti-CRISPR genes (typical for T4-like phages)                  │
│  - 2 CRISPR spacers match T4 sequences (gp23, gp34)                         │
│  - Infection may succeed if CRISPR interference is incomplete               │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

Gene Map with Defense Annotations:
──[rIIA]──[Alt]──[ModA]──[Dam]────────[Arn]──────────────────────────
    │       │      │       │            │
   Abi     RM     RM      RM          Abi
  evasion bypass bypass  bypass      evasion

[H] Change host   [D] Defense details   [G] Show gene   [ESC] Exit
```

---

## 9) Phage Cocktail Compatibility Matrix

### Concept

Phage therapy rarely uses single phages — **cocktails** of multiple phages are essential to:
1. Cover diverse host strains
2. Prevent resistance emergence
3. Ensure redundant killing mechanisms

But not all phages work together. Some interfere through:
- **Superinfection exclusion**: One phage blocks another from entering
- **Receptor competition**: Both need the same receptor (one wins)
- **Lysis timing conflicts**: Different burst schedules cause resource waste
- **Immunity/Lysogeny**: Temperate phage provides immunity against related phages

This feature computes a **compatibility matrix** across all phages and solves the **optimal cocktail selection problem**: find the minimal set of phages that covers the target host range with no compatibility conflicts.

### Mathematical Foundations

**Compatibility scoring:**
```
For phages A and B, compatibility score C(A,B) ∈ [-1, +1]:

Positive factors (synergy):
  - Different receptors: +0.3
  - Different lysis timing (early + late): +0.2
  - Complementary host ranges: +0.3
  - No sequence homology in immunity regions: +0.2

Negative factors (interference):
  - Same receptor: -0.4
  - Superinfection exclusion genes detected: -0.5
  - Similar lysis timing: -0.2
  - Sie genes present in both: -0.3
  - One is temperate and provides immunity to other: -0.8

C(A,B) = Σ positive_factors - Σ negative_factors
Clamp to [-1, +1]
```

**Host range coverage:**
```
Let H = {h₁, h₂, ..., hₘ} be target hosts
Let P = {p₁, p₂, ..., pₙ} be candidate phages
Let R[i,j] = 1 if phage pᵢ infects host hⱼ, else 0

Coverage of subset S ⊆ P:
  Cov(S) = { hⱼ : ∃ pᵢ ∈ S with R[i,j] = 1 }
```

**Optimal cocktail as Set Cover + Compatibility:**
```
Maximize: |Cov(S)| (hosts covered)

Subject to:
  |S| ≤ k (max cocktail size, typically 3-5)
  ∀ pᵢ, pⱼ ∈ S: C(pᵢ, pⱼ) > threshold (no conflicts)

This is NP-hard (set cover). Solutions:
  - Greedy: Add phage with best coverage/compatibility ratio
  - ILP: Optimal but slower
  - Genetic algorithm: For large phage libraries
```

**ILP formulation:**
```
Variables:
  xᵢ ∈ {0,1} = 1 if phage i selected
  yⱼ ∈ {0,1} = 1 if host j covered

Maximize: Σⱼ yⱼ

Subject to:
  Σᵢ xᵢ ≤ k                           (cocktail size limit)
  yⱼ ≤ Σᵢ R[i,j] × xᵢ                 (coverage constraint)
  xᵢ + xⱼ ≤ 1 for incompatible pairs  (compatibility constraint)
```

### Implementation Approach

**Feature extraction for compatibility:**
```typescript
interface PhageInterferenceFeatures {
  phageId: number;
  receptorGenes: string[];          // e.g., ['OmpC', 'LamB']
  sieGenes: string[];               // Superinfection exclusion
  lysisTime: 'early' | 'middle' | 'late';
  lifecycle: 'lytic' | 'temperate';
  immunityRegion?: string;          // For temperate phages
  hostRange: Set<string>;           // Confirmed hosts
}

async function extractInterferenceFeatures(
  phage: PhageFull
): Promise<PhageInterferenceFeatures> {
  const genes = phage.genes;

  // Detect receptor-binding proteins
  const rbpGenes = genes.filter(g =>
    g.product?.match(/tail fiber|receptor.binding|attachment/i)
  );
  const receptorGenes = await predictReceptors(rbpGenes);

  // Detect superinfection exclusion genes
  const sieGenes = genes.filter(g =>
    g.product?.match(/superinfection|exclusion|imm|sie/i) ||
    SIE_HMM_PROFILES.some(p => matchesProfile(g, p))
  ).map(g => g.name);

  // Predict lysis timing from holin/endolysin position
  const lysisGenes = genes.filter(g =>
    g.product?.match(/holin|lysin|endolysin/i)
  );
  const lysisTime = predictLysisTiming(lysisGenes, phage.length);

  // Detect temperate markers
  const lifecycle = genes.some(g =>
    g.product?.match(/integrase|repressor|CI|excisionase/i)
  ) ? 'temperate' : 'lytic';

  // Extract immunity region for temperate phages
  const immunityRegion = lifecycle === 'temperate'
    ? extractImmunityRegion(genes)
    : undefined;

  return {
    phageId: phage.id,
    receptorGenes,
    sieGenes,
    lysisTime,
    lifecycle,
    immunityRegion,
    hostRange: new Set(phage.hosts)
  };
}
```

**Pairwise compatibility calculation:**
```typescript
interface CompatibilityScore {
  phageA: number;
  phageB: number;
  score: number;  // -1 to +1
  factors: { name: string; contribution: number; reason: string }[];
  compatible: boolean;  // score > threshold
}

function computeCompatibility(
  featuresA: PhageInterferenceFeatures,
  featuresB: PhageInterferenceFeatures,
  threshold: number = 0.0
): CompatibilityScore {
  const factors: CompatibilityScore['factors'] = [];

  // Receptor overlap
  const receptorOverlap = setIntersection(
    new Set(featuresA.receptorGenes),
    new Set(featuresB.receptorGenes)
  ).size;
  if (receptorOverlap > 0) {
    factors.push({
      name: 'Receptor competition',
      contribution: -0.4,
      reason: `Both use: ${[...setIntersection].join(', ')}`
    });
  } else {
    factors.push({
      name: 'Different receptors',
      contribution: +0.3,
      reason: 'No receptor overlap'
    });
  }

  // Superinfection exclusion
  if (featuresA.sieGenes.length > 0 || featuresB.sieGenes.length > 0) {
    factors.push({
      name: 'Sie genes present',
      contribution: -0.5,
      reason: 'May block co-infection'
    });
  }

  // Lysis timing
  if (featuresA.lysisTime !== featuresB.lysisTime) {
    factors.push({
      name: 'Different lysis timing',
      contribution: +0.2,
      reason: `${featuresA.lysisTime} + ${featuresB.lysisTime}`
    });
  } else {
    factors.push({
      name: 'Same lysis timing',
      contribution: -0.2,
      reason: 'Competition for resources'
    });
  }

  // Immunity cross-reaction (temperate phages)
  if (featuresA.immunityRegion && featuresB.immunityRegion) {
    const similarity = sequenceIdentity(
      featuresA.immunityRegion,
      featuresB.immunityRegion
    );
    if (similarity > 0.7) {
      factors.push({
        name: 'Cross-immunity',
        contribution: -0.8,
        reason: `${(similarity * 100).toFixed(0)}% immunity region identity`
      });
    }
  }

  // Host range complementarity
  const hostOverlap = setIntersection(
    featuresA.hostRange,
    featuresB.hostRange
  ).size;
  const totalHosts = setUnion(
    featuresA.hostRange,
    featuresB.hostRange
  ).size;
  const complementarity = 1 - hostOverlap / totalHosts;
  factors.push({
    name: 'Host range complementarity',
    contribution: complementarity * 0.3,
    reason: `${(complementarity * 100).toFixed(0)}% unique hosts`
  });

  const score = Math.max(-1, Math.min(1,
    factors.reduce((sum, f) => sum + f.contribution, 0)
  ));

  return {
    phageA: featuresA.phageId,
    phageB: featuresB.phageId,
    score,
    factors,
    compatible: score >= threshold
  };
}
```

**Optimal cocktail solver:**
```typescript
interface CocktailSolution {
  phages: number[];
  coverage: string[];  // Hosts covered
  coveragePercent: number;
  compatibilityScore: number;  // Average pairwise score
  rationale: string[];
}

function solveOptimalCocktail(
  phages: PhageInterferenceFeatures[],
  targetHosts: string[],
  compatibilityMatrix: CompatibilityScore[][],
  maxSize: number = 4,
  compatibilityThreshold: number = 0.0
): CocktailSolution {
  const n = phages.length;
  const m = targetHosts.length;

  // Greedy approach (good for most cases)
  const selected: number[] = [];
  const covered = new Set<string>();

  while (selected.length < maxSize && covered.size < m) {
    let bestPhage = -1;
    let bestScore = -Infinity;

    for (let i = 0; i < n; i++) {
      if (selected.includes(i)) continue;

      // Check compatibility with already selected
      const compatible = selected.every(j =>
        compatibilityMatrix[i][j].score >= compatibilityThreshold
      );
      if (!compatible) continue;

      // Calculate marginal coverage gain
      const newCoverage = [...phages[i].hostRange]
        .filter(h => targetHosts.includes(h) && !covered.has(h));

      // Score = coverage gain + average compatibility boost
      const avgCompat = selected.length === 0 ? 0 :
        selected.reduce((sum, j) => sum + compatibilityMatrix[i][j].score, 0) /
        selected.length;

      const score = newCoverage.length + avgCompat * 0.5;

      if (score > bestScore) {
        bestScore = score;
        bestPhage = i;
      }
    }

    if (bestPhage === -1) break;  // No compatible phage found

    selected.push(bestPhage);
    for (const host of phages[bestPhage].hostRange) {
      if (targetHosts.includes(host)) {
        covered.add(host);
      }
    }
  }

  // Compute final metrics
  const avgCompatibility = selected.length < 2 ? 1.0 :
    pairwiseAverage(selected, compatibilityMatrix);

  return {
    phages: selected,
    coverage: [...covered],
    coveragePercent: covered.size / m * 100,
    compatibilityScore: avgCompatibility,
    rationale: generateRationale(selected, phages, compatibilityMatrix)
  };
}
```

### Why This Is a Good Idea

1. **Clinical relevance**: Phage therapy design is currently done by expert intuition. This tool provides quantitative guidance.

2. **Resistance prevention**: Cocktails are essential to prevent resistance. But bad combinations are worse than single phages.

3. **Scalable optimization**: As phage libraries grow (thousands of phages), manual selection becomes impossible.

4. **Explainable recommendations**: Not just "use these" but "because X covers hosts Y, and Z adds receptor diversity."

5. **Novel contribution**: No existing tool combines compatibility scoring with coverage optimization.

### Innovation Assessment

**Novelty: VERY HIGH**

Phage cocktail design is done manually or with simple host-range tables. This is:
- First computational compatibility predictor
- First cocktail optimization solver for phages
- Novel integration of molecular interference mechanisms
- Unique TUI interface for cocktail design

### Pedagogical Value: 9/10

Teaches:
- **Phage interference mechanisms**: Sie, receptor competition, immunity
- **Combinatorial optimization**: Set cover, ILP, greedy algorithms
- **Therapy design principles**: Why cocktails beat monotherapy
- **Host range ecology**: How phages partition bacterial populations

### Cool/Wow Factor: 9/10

The heatmap matrix showing green (compatible) and red (incompatible) pairs is immediately intuitive. Watching the algorithm select an optimal cocktail — with rationale — feels like having an expert consultant.

### TUI Visualization

```
Phage Cocktail Compatibility Matrix
═══════════════════════════════════════════════════════════════════════════════

Compatibility Heatmap (12 phages):
          │ λ   T4  T7  P22 M13 Mu  Φ29 Φ6  T5  SPβ HK97 P1  │
──────────┼─────────────────────────────────────────────────────┤
Lambda    │ ·   +0.6 +0.4 -0.3 +0.8 +0.2 +0.5 +0.7 +0.1 -0.7 +0.3 +0.4 │
T4        │     ·    +0.5 +0.6 +0.7 +0.3 +0.4 +0.8 +0.6 +0.4 +0.5 +0.5 │
T7        │          ·    +0.5 +0.6 +0.4 +0.8 +0.7 +0.3 +0.3 +0.4 +0.5 │
P22       │               ·    +0.5 -0.2 +0.3 +0.6 +0.4 +0.5 -0.4 +0.3 │
M13       │                    ·    +0.2 +0.6 +0.5 +0.5 +0.3 +0.2 +0.4 │
Mu        │                         ·    +0.3 +0.4 +0.2 +0.1 +0.3 -0.5 │
Phi29     │                              ·    +0.8 +0.4 +0.3 +0.5 +0.4 │
Phi6      │                                   ·    +0.6 +0.5 +0.6 +0.5 │
T5        │                                        ·    +0.3 +0.4 +0.3 │
SPbeta    │                                             ·    +0.2 +0.1 │
HK97      │                                                  ·    +0.4 │
P1        │                                                       ·    │
──────────┴─────────────────────────────────────────────────────────────┘

Legend: ▓▓▓ +0.8 ▒▒▒ +0.4 ░░░ 0.0 ··· -0.4 ▫▫▫ -0.8

⚠ Incompatible pairs:
  Lambda × SPbeta (-0.7): Cross-immunity (temperate, 78% identity)
  Lambda × P22 (-0.3): Same receptor (LamB)

───────────────────────────────────────────────────────────────────────────────

COCKTAIL OPTIMIZER

Target hosts: E. coli K-12, B, C; Salmonella; P. aeruginosa (5 total)

Solving for optimal cocktail (max size: 3)...

✓ RECOMMENDED COCKTAIL:
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                              │
│  1. T4          Covers: E. coli K-12, E. coli B        Lysis: late          │
│  2. T7          Covers: E. coli K-12, E. coli C        Lysis: early         │
│  3. Phi6        Covers: P. aeruginosa                  Lysis: middle        │
│                                                                              │
│  Coverage: 4/5 hosts (80%)  ████████░░                                      │
│  Compatibility: +0.67       ██████▓▓░░                                      │
│                                                                              │
│  Missing: Salmonella (consider adding P22)                                  │
│                                                                              │
│  RATIONALE:                                                                  │
│  • T4 + T7: Different lysis timing (early + late = sustained killing)       │
│  • T4 + T7: No receptor overlap (OmpC vs various)                           │
│  • Phi6: Unique host range (Pseudomonas-specific)                           │
│  • All lytic: No immunity/lysogeny conflicts                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘

[+] Add constraint   [H] Change hosts   [S] Solve again   [E] Export   [ESC] Exit
```

---

## 10) RNA Structure & Packaging Signal Explorer

### Concept

DNA and RNA are not just sequences — they fold into **three-dimensional structures** that control biology. For phages, RNA structure is critical in:

1. **Packaging signals**: Specific stem-loops tell the terminase "start packaging here"
2. **Translational control**: 5' UTR structures regulate ribosome binding
3. **Regulatory switches**: Riboswitches and attenuators control gene expression
4. **RNA phages**: For MS2, Qβ, etc., the entire genome IS the structure

This explorer predicts RNA secondary structure along the genome, identifies conserved structural motifs, and highlights packaging signals — revealing the hidden regulatory architecture.

### Mathematical Foundations

**RNA folding thermodynamics:**
```
RNA folds to minimize free energy ΔG:
  ΔG = ΔH - TΔS

For a structure S with base pairs B:
  ΔG(S) = Σᵢⱼ∈B ΔG(i,j) + Σ ΔG(loops) + Σ ΔG(dangles)

Where:
  ΔG(i,j) = stacking energy for base pair (nearest-neighbor model)
  Loop contributions: hairpin, bulge, internal, multi-loop
  Dangles: unpaired bases at helix ends
```

**Minimum Free Energy (MFE) algorithm (Zuker):**
```
Dynamic programming over all possible structures:

W(i,j) = minimum energy for subsequence [i,j]
       = min( W(i,j-1),                    // j unpaired
              min over k: W(i,k-1) + V(k,j) )  // j paired with k

V(i,j) = energy of structure with (i,j) pair
       = min( Hairpin(i,j),
              min over p,q: V(p,q) + Internal(i,j,p,q),
              Multi-branch )

Time: O(n³), Space: O(n²)
```

**Partition function for base pair probabilities:**
```
Z = Σₛ exp(-ΔG(S) / RT)  // Sum over all structures

P(i,j paired) = Z(i,j) / Z

High probability = confident base pair
Low probability = structural ambiguity (regulatory?)
```

**Covariance analysis for conserved structure:**
```
Given multiple sequence alignment:
  - Identify compensatory mutations: A-U → G-C preserves pair
  - Score: covariance(i,j) = Σ f(Xᵢ=a, Xⱼ=b) log(f(a,b) / f(a)f(b))

High covariance = structurally constrained (pairing preserved)
```

**Packaging signal motifs:**
```
Known packaging signals:
  Lambda cos site: 12-bp cohesive ends + flanking structure
  T4 pac site: ~170 bp with specific stem-loops
  Phi29: pRNA (packaging RNA) with complex pseudoknot

Detection:
  - Infernal cmsearch with covariance models (CMs)
  - Or de novo: sliding window MFE + structural conservation
```

### Implementation Approach

**ViennaRNA wrapper:**
```typescript
interface RNAFoldResult {
  sequence: string;
  structure: string;      // Dot-bracket notation
  mfe: number;           // kcal/mol
  ensembleEnergy: number;
  basePairProbs: Float32Array;  // Upper triangular matrix
}

async function foldRNA(
  sequence: string,
  temperature: number = 37
): Promise<RNAFoldResult> {
  // Call ViennaRNA RNAfold
  const result = await exec(
    `echo "${sequence}" | RNAfold -p -T ${temperature} --noPS`
  );

  // Parse output
  const lines = result.stdout.split('\n');
  const structure = lines[1].split(' ')[0];
  const mfe = parseFloat(lines[1].match(/-?\d+\.\d+/)[0]);

  // Parse base pair probabilities from dp.ps file
  const probs = parseBasePairProbs(lines);

  return {
    sequence,
    structure,
    mfe,
    ensembleEnergy: parseEnsembleEnergy(lines),
    basePairProbs: probs
  };
}

// Sliding window analysis
interface WindowFold {
  start: number;
  end: number;
  mfe: number;
  mfePerBase: number;
  structure: string;
  stemLoops: StemLoop[];
}

async function slidingWindowFold(
  sequence: string,
  windowSize: number = 200,
  stepSize: number = 50
): Promise<WindowFold[]> {
  const results: WindowFold[] = [];

  for (let start = 0; start <= sequence.length - windowSize; start += stepSize) {
    const window = sequence.slice(start, start + windowSize);
    const fold = await foldRNA(window);

    results.push({
      start,
      end: start + windowSize,
      mfe: fold.mfe,
      mfePerBase: fold.mfe / windowSize,
      structure: fold.structure,
      stemLoops: extractStemLoops(fold.structure, start)
    });
  }

  return results;
}
```

**Stem-loop extraction:**
```typescript
interface StemLoop {
  start: number;
  end: number;
  stemLength: number;
  loopLength: number;
  sequence: string;
  structure: string;
  stability: number;  // ΔG
}

function extractStemLoops(structure: string, offset: number = 0): StemLoop[] {
  const stemLoops: StemLoop[] = [];
  const stack: number[] = [];

  // Find balanced parentheses
  for (let i = 0; i < structure.length; i++) {
    if (structure[i] === '(') {
      stack.push(i);
    } else if (structure[i] === ')') {
      const start = stack.pop()!;

      // Check if this is a complete stem-loop (not internal pair)
      if (isCompleteStemLoop(structure, start, i)) {
        const { stemLen, loopLen } = measureStemLoop(structure, start, i);

        stemLoops.push({
          start: start + offset,
          end: i + offset,
          stemLength: stemLen,
          loopLength: loopLen,
          sequence: '', // Filled later
          structure: structure.slice(start, i + 1),
          stability: estimateStemLoopEnergy(stemLen, loopLen)
        });
      }
    }
  }

  return stemLoops;
}

function isCompleteStemLoop(structure: string, start: number, end: number): boolean {
  // Check that all characters between start and end are part of this stem-loop
  let depth = 0;
  for (let i = start; i <= end; i++) {
    if (structure[i] === '(') depth++;
    else if (structure[i] === ')') depth--;

    if (depth === 0 && i < end) return false;  // Closed before end
  }
  return true;
}
```

**Packaging signal detection:**
```typescript
interface PackagingSignal {
  type: 'cos' | 'pac' | 'pRNA' | 'unknown';
  position: number;
  length: number;
  sequence: string;
  structure: string;
  confidence: number;
  annotation: string;
}

// Covariance model library for known packaging signals
const PACKAGING_CMS = new Map<string, string>([
  ['lambda_cos', 'cms/lambda_cos.cm'],
  ['t4_pac', 'cms/t4_pac.cm'],
  ['phi29_prna', 'cms/phi29_pRNA.cm'],
  ['p22_pac', 'cms/p22_pac.cm'],
]);

async function detectPackagingSignals(
  sequence: string,
  phageFamily?: string
): Promise<PackagingSignal[]> {
  const signals: PackagingSignal[] = [];

  // Run Infernal cmsearch with relevant CMs
  for (const [name, cmPath] of PACKAGING_CMS) {
    const result = await exec(
      `cmsearch --tblout /dev/stdout ${cmPath} -`
    , { input: `>query\n${sequence}` });

    const hits = parseInfernalOutput(result.stdout);
    for (const hit of hits) {
      if (hit.eValue < 1e-5) {
        signals.push({
          type: name.split('_')[1] as PackagingSignal['type'],
          position: hit.start,
          length: hit.end - hit.start,
          sequence: sequence.slice(hit.start, hit.end),
          structure: await predictLocalStructure(sequence, hit.start, hit.end),
          confidence: Math.min(1, 1 / (hit.eValue + 1e-10)),
          annotation: `${name} (E=${hit.eValue.toExponential(2)})`
        });
      }
    }
  }

  // De novo detection: look for stable stem-loops near genome ends
  const terminalRegions = [
    { start: 0, end: 500, name: 'left_end' },
    { start: sequence.length - 500, end: sequence.length, name: 'right_end' },
  ];

  for (const region of terminalRegions) {
    const folds = await slidingWindowFold(
      sequence.slice(region.start, region.end),
      100, 20
    );

    // Find unusually stable structures
    const avgMFE = folds.reduce((s, f) => s + f.mfePerBase, 0) / folds.length;
    const stableFolds = folds.filter(f => f.mfePerBase < avgMFE - 0.1);

    for (const fold of stableFolds) {
      if (fold.stemLoops.some(sl => sl.stemLength >= 6)) {
        signals.push({
          type: 'unknown',
          position: region.start + fold.start,
          length: fold.end - fold.start,
          sequence: sequence.slice(region.start + fold.start, region.start + fold.end),
          structure: fold.structure,
          confidence: 0.5,
          annotation: `De novo: strong stem-loop at ${region.name}`
        });
      }
    }
  }

  return signals;
}
```

**Conservation-aware structure prediction:**
```typescript
interface ConservedStructure {
  position: number;
  length: number;
  consensusStructure: string;
  covariance: number;  // Evidence for conserved pairing
  compensatoryMutations: CompensatoryMutation[];
  phagesPresent: string[];
}

interface CompensatoryMutation {
  position1: number;
  position2: number;
  changes: string[];  // e.g., ["A-U → G-C", "G-C → A-U"]
}

async function findConservedStructures(
  alignment: MultipleAlignment,
  windowSize: number = 100
): Promise<ConservedStructure[]> {
  const conserved: ConservedStructure[] = [];

  for (let start = 0; start < alignment.length - windowSize; start += windowSize / 2) {
    const window = extractAlignmentWindow(alignment, start, windowSize);

    // Compute consensus structure
    const consensus = await computeConsensusStructure(window);

    // Look for compensatory mutations
    const compensatory = findCompensatoryMutations(window, consensus.basePairs);

    if (compensatory.length > 2) {  // Significant covariation
      conserved.push({
        position: start,
        length: windowSize,
        consensusStructure: consensus.structure,
        covariance: computeCovarianceScore(compensatory),
        compensatoryMutations: compensatory,
        phagesPresent: window.sequences.map(s => s.name)
      });
    }
  }

  return conserved;
}
```

### Why This Is a Good Idea

1. **Packaging is fundamental**: Every phage must package its genome. Understanding packaging signals is essential for phage engineering.

2. **Regulatory discovery**: Many regulatory elements are RNA structures (riboswitches, attenuators). This reveals the hidden control layer.

3. **RNA phage biology**: For RNA phages, the genome IS the structure. You can't understand them without folding.

4. **Structural conservation = function**: Conserved structures (covariance) indicate functional importance even without sequence conservation.

5. **Engineering applications**: Designing synthetic phages requires placing genes relative to packaging signals.

### Innovation Assessment

**Novelty: MEDIUM-HIGH**

RNA folding tools exist (ViennaRNA, RNAfold, Mfold), but:
- No integration with genome browsers
- No packaging signal detection
- No conservation-based structure finding
- No TUI visualization with structure + sequence

### Pedagogical Value: 9/10

Teaches:
- **RNA secondary structure**: Base pairing, stems, loops, pseudoknots
- **Thermodynamics**: Free energy minimization
- **Covariance**: How conservation reveals structure
- **Packaging mechanisms**: How phages recognize their own DNA
- **Regulatory RNA**: Non-coding but essential

### Cool/Wow Factor: 8/10

Seeing the genome's RNA structure rendered in dot-bracket notation — with stem-loops highlighted and packaging signals flagged — reveals a hidden layer of genomic information. The ΔG sparkline showing structural stability along the genome is visually compelling.

### TUI Visualization

```
RNA Structure Explorer: Lambda phage
═══════════════════════════════════════════════════════════════════════════════

Free Energy Profile (ΔG per 100bp window):
  0 ┤────────────────────────────────────────────────────────────────
-10 ┤  ╭───╮          ╭─────╮              ╭────────╮
-20 ┤  │   ╰──────────╯     ╰──────────────╯        ╰────────────────
-30 ┤──╯            ↑                   ↑
-40 ┤           cos site            attP
    ╰────────────────────────────────────────────────────────────────
     0        10k        20k        30k        40k       48.5k

───────────────────────────────────────────────────────────────────────────────

PACKAGING SIGNAL DETECTED: cos site (position 48,490 - 48,502)

Sequence:  5'- G G G C G G C G A C C T -3'
Structure:     ( ( ( ( ( . . . ) ) ) ) )
               ╰─╯ ╰─╯ ╰─────╯ ╰─╯ ╰─╯
               stem    loop    stem

Detailed fold:
                 A
                C   C
               G     G
              G───────C
              G───────C   ← 12-bp cohesive ends
              G───────C       (sticky ends for circularization)
              C───────G
              G───────C
              5'     3'

Confidence: ██████████ 99% (matches lambda cos CM, E=1.2e-15)

───────────────────────────────────────────────────────────────────────────────

REGULATORY STRUCTURES:

Position    Type              ΔG      Structure           Annotation
─────────────────────────────────────────────────────────────────────────────
189-245     5' UTR hairpin   -12.3   (((((.......)))))   N gene RBS occlusion
2,890-2,950 Attenuator       -18.7   ((((....))))...((   cII transcription
15,220-15,300 Stem-loop      -22.1   (((((((....)))))))  Q antiterminator
38,100-38,180 Terminator     -28.5   (((((((....)))))))) tR2 Rho-independent

───────────────────────────────────────────────────────────────────────────────

Structure at cursor (position 15,220):

    Sequence: CGCUAAGCGCUUUGCAUAGCGCUUAGCG
    Structure: (((((((((.......)))))))))..

    Rendered:
                         U
                       G   U
                      U     G
                     A       C
                    A         A
                   G───────────C    ← Q antiterminator
                   C───────────G       recognition structure
                   G───────────C
                   C───────────G
                   G───────────C
                   A───────────U
                   A───────────U
                   G───────────C
                   C═══════════G
                  5'            3'

[←/→] Navigate   [W] Window size   [C] Show conservation   [P] Find packaging   [ESC] Exit
```

## Integration Notes
- All heavy compute pieces slated for Rust+WASM where tight loops or HMMs are needed; lightweight stats stay in TypeScript/Bun.
- Precompute everything into SQLite side tables to keep the TUI snappy; lazy-load large artifacts (embeddings, structures) on demand.
- Keep visual layers optional so low-spec terminals remain responsive.

---

# Additional High-Impact Feature Proposals

The following ideas complement the existing roadmap with features not covered above, focusing on mathematical elegance, biological insight, and TUI visualization potential.

---

## 11) Cumulative GC Skew Replication Origin Detector

### Concept

Every genome leaves mathematical fingerprints of its replication process in nucleotide composition. During replication, leading and lagging strands experience different mutational pressures (C→T deamination bias), creating **strand asymmetry** that accumulates around the origin and terminus.

By computing the cumulative GC skew, we reveal:
- **Replication origin**: Global minimum of cumulative skew curve
- **Terminus**: Global maximum
- **Replication mode**: Theta (bidirectional) vs rolling circle (unidirectional)

The mathematics is elegant: a simple cumulative sum transforms noisy local composition into a beautiful sinusoidal curve where extrema correspond to biologically critical positions.

### Mathematical Foundations

**GC Skew in sliding window:**
```
skew[i] = (G_count - C_count) / (G_count + C_count)  for window at position i
```

**Cumulative skew:**
```
S[0] = 0
S[i] = S[i-1] + skew[i]

Origin = argmin(S)  // Global minimum
Terminus = argmax(S)  // Global maximum
```

**Z-curve representation (3D encoding):**
```
x_n = (A_n + G_n) - (C_n + T_n)  // Purine vs pyrimidine
y_n = (A_n + C_n) - (G_n + T_n)  // Amino vs keto
z_n = (A_n + T_n) - (G_n + C_n)  // Weak vs strong H-bonds

The cumulative Z-curve creates a 3D parametric curve encoding ALL compositional information.
```

**Optional Fourier analysis:**
```
FFT of skew signal reveals periodicity and multiple origins (unusual but possible in some phages).
```

### Implementation Approach

**Pure TypeScript** — no external dependencies:

```typescript
interface ReplicationAnalysis {
  gcSkew: Float64Array;
  cumulativeSkew: Float64Array;
  predictedOrigin: number;      // Position of global minimum
  predictedTerminus: number;    // Position of global maximum
  confidence: number;           // Signal strength
  zCurve?: { x: Float64Array; y: Float64Array; z: Float64Array };
}

function analyzeReplicationOrigin(
  sequence: string,
  windowSize: number = 1000,
  stepSize: number = 100
): ReplicationAnalysis {
  const n = Math.floor((sequence.length - windowSize) / stepSize) + 1;
  const gcSkew = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const start = i * stepSize;
    const window = sequence.slice(start, start + windowSize);
    const G = (window.match(/G/gi) || []).length;
    const C = (window.match(/C/gi) || []).length;
    gcSkew[i] = (G + C > 0) ? (G - C) / (G + C) : 0;
  }

  // Cumulative sum with extrema tracking
  const cumulativeSkew = new Float64Array(n);
  let sum = 0, minVal = Infinity, minIdx = 0, maxVal = -Infinity, maxIdx = 0;

  for (let i = 0; i < n; i++) {
    sum += gcSkew[i];
    cumulativeSkew[i] = sum;
    if (sum < minVal) { minVal = sum; minIdx = i; }
    if (sum > maxVal) { maxVal = sum; maxIdx = i; }
  }

  return {
    gcSkew, cumulativeSkew,
    predictedOrigin: minIdx * stepSize,
    predictedTerminus: maxIdx * stepSize,
    confidence: (maxVal - minVal) / Math.abs(sum / n + 0.001)
  };
}
```

**Z-curve for 3D visualization:**
```typescript
function computeZCurve(sequence: string): ZCurve3D {
  const x = new Float64Array(sequence.length);
  const y = new Float64Array(sequence.length);
  const z = new Float64Array(sequence.length);
  let xSum = 0, ySum = 0, zSum = 0;

  for (let i = 0; i < sequence.length; i++) {
    switch (sequence[i].toUpperCase()) {
      case 'A': xSum += 1; ySum += 1; zSum += 1; break;
      case 'G': xSum += 1; ySum -= 1; zSum -= 1; break;
      case 'C': xSum -= 1; ySum += 1; zSum -= 1; break;
      case 'T': xSum -= 1; ySum -= 1; zSum += 1; break;
    }
    x[i] = xSum; y[i] = ySum; z[i] = zSum;
  }
  return { x, y, z };
}
```

**Performance:** O(n) scan, trivial for phage genomes. Pure TypeScript is sufficient.

### Why This Is a Good Idea

1. **Fundamental biology**: Replication origin is THE most important genomic position
2. **Pure signal from sequence**: No annotation needed — math reveals biology
3. **Validation opportunity**: Compare prediction to annotated dnaA/rep genes
4. **Comparative value**: Compare replication strategies across phages (theta vs rolling circle)
5. **Cloning applications**: Know where to insert genes for optimal expression

### Innovation Assessment

**Novelty: MEDIUM**

GC skew analysis is a classic technique (Lobry 1996), and tools like Ori-Finder exist. However:
- No TUI genome browser includes this
- Interactive exploration with gene overlay is novel
- Z-curve 3D visualization in ASCII is unprecedented
- Comparative view across multiple phages is powerful

### Pedagogical Value: 9/10

Teaches:
- **Replication biology**: Why origins and termini exist
- **Mutational bias**: Why strands have different compositions
- **Mathematical biology**: Elegant sequence → function relationship
- **Signal processing**: Cumulative sums reveal hidden patterns

### Cool/Wow Factor: 8/10

The cumulative GC skew curve is inherently beautiful — a smooth sinusoid rising and falling as you traverse the genome. When the minimum aligns perfectly with the annotated origin, it's deeply satisfying.

### TUI Visualization

```
Cumulative GC Skew                    Origin    Terminus
                                         ↓         ↓
    +2.0 ┤                              ╭────────╮
    +1.5 ┤                           ╭──╯        ╰──╮
    +1.0 ┤                        ╭──╯              ╰──╮
    +0.5 ┤                     ╭──╯                    ╰──╮
     0.0 ┼─────────────────────╯                          ╰─────
    -0.5 ┤  ╭──╮            ╭──╯
    -1.0 ┤──╯  ╰────────────╯
         ╰─────────────────────────────────────────────────────
         0        10k       20k       30k       40k       48k

Genes: ──[dnaA]──────[recA]─────[rep]──────[cos]──────[att]──
           ↑                      ↑
       Origin confirmed       Terminus confirmed

Comparative view:
Lambda   ▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓  (39%)
T7       ░▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  (2%)
PhiX174  ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓░  (rolling)
```

---

## 12) Selection Pressure Chromosome Painter (dN/dS Landscape)

### Concept

Evolution leaves fingerprints in mutation patterns. **Synonymous mutations** (change DNA but not protein) accumulate neutrally. **Non-synonymous mutations** (change protein) are filtered by selection:

- **ω (dN/dS) < 1**: Purifying selection — protein is essential, changes deleterious
- **ω ≈ 1**: Neutral evolution — no constraint
- **ω > 1**: Positive selection — adaptive evolution, arms race with host

By computing dN/dS across genes and along sliding windows, we create a **chromosome painting** showing evolutionary pressure: blue for essential (purifying), red for arms race (positive), gray for neutral.

### Mathematical Foundations

**Nei-Gojobori method for dN/dS:**
```
For aligned codon pair (codon_A, codon_B):
  1. Count synonymous sites (S) and non-synonymous sites (N)
  2. Count synonymous differences (Sd) and non-synonymous differences (Nd)

  pS = Sd / S  (proportion synonymous differences)
  pN = Nd / N  (proportion non-synonymous differences)

  // Jukes-Cantor correction for multiple hits
  dS = -0.75 × ln(1 - 4×pS/3)
  dN = -0.75 × ln(1 - 4×pN/3)

  ω = dN / dS
```

**Statistical significance (Z-test):**
```
Z = (dN - dS) / sqrt(Var(dN) + Var(dS))
P-value from standard normal distribution
```

**Sliding window for within-gene variation:**
```
Window of 30 codons, step of 10 codons
Compute ω per window with bootstrap CI
Flag regions where ω significantly > 1 or < 1
```

### Implementation Approach

**Codon-aware alignment (critical step):**
```typescript
interface CodonAlignment {
  codonsA: string[];
  codonsB: string[];
  geneId: string;
}

function alignCodons(
  geneA: { dna: string; aa: string },
  geneB: { dna: string; aa: string }
): CodonAlignment {
  // 1. Align amino acid sequences (preserve reading frame)
  const aaAlign = needlemanWunsch(geneA.aa, geneB.aa);

  // 2. Thread DNA codons through the AA alignment
  const codonsA: string[] = [];
  const codonsB: string[] = [];
  let posA = 0, posB = 0;

  for (let i = 0; i < aaAlign.alignedA.length; i++) {
    codonsA.push(aaAlign.alignedA[i] === '-'
      ? '---'
      : geneA.dna.slice(posA++ * 3, posA * 3));
    codonsB.push(aaAlign.alignedB[i] === '-'
      ? '---'
      : geneB.dna.slice(posB++ * 3, posB * 3));
  }

  return { codonsA, codonsB, geneId: geneA.id };
}
```

**dN/dS calculation:**
```typescript
// Precompute: degeneracy of each codon position
const CODON_DEGENERACY = computeDegeneracyTable();

interface DnDsResult {
  dN: number;
  dS: number;
  omega: number;
  pValue: number;
  interpretation: 'purifying' | 'neutral' | 'positive';
}

function computeDnDs(codonPairs: [string, string][]): DnDsResult {
  let Sd = 0, Nd = 0, S = 0, N = 0;

  for (const [codonA, codonB] of codonPairs) {
    if (codonA === '---' || codonB === '---' || codonA === codonB) continue;

    // Count sites and differences
    const sites = countSites(codonA);
    S += sites.synonymous;
    N += sites.nonsynonymous;

    const diffs = countDifferences(codonA, codonB);
    Sd += diffs.synonymous;
    Nd += diffs.nonsynonymous;
  }

  // Jukes-Cantor correction
  const pS = Sd / S, pN = Nd / N;
  const dS = -0.75 * Math.log(1 - 4 * pS / 3);
  const dN = -0.75 * Math.log(1 - 4 * pN / 3);
  const omega = dS > 0 ? dN / dS : 1;

  // Z-test
  const varDn = pN * (1 - pN) / N;
  const varDs = pS * (1 - pS) / S;
  const z = (dN - dS) / Math.sqrt(varDn + varDs);
  const pValue = 2 * (1 - normalCDF(Math.abs(z)));

  return {
    dN, dS, omega, pValue,
    interpretation: omega > 1.2 && pValue < 0.05 ? 'positive'
                  : omega < 0.8 && pValue < 0.05 ? 'purifying'
                  : 'neutral'
  };
}
```

**Performance:** O(n) per gene pair. TypeScript sufficient for phage-sized genomes.

### Why This Is a Good Idea

1. **Core evolutionary biology**: dN/dS is THE metric for detecting selection
2. **Arms race detection**: Positive selection = phage-host coevolution hotspots
3. **Essential gene identification**: Strong purifying = functional importance
4. **Therapeutic relevance**: Predict which features will evolve resistance
5. **Research value**: Immediate insight into evolutionary dynamics

### Innovation Assessment

**Novelty: MEDIUM**

dN/dS tools exist (PAML, HyPhy, MEGA), but:
- No integration with interactive genome browsers
- No sliding window visualization in TUI
- "Chromosome painting" metaphor is visually novel
- Comparative view across phages is powerful

### Pedagogical Value: 10/10

Teaches:
- **Natural selection**: The core concept made quantitative
- **Molecular evolution**: How selection acts on coding sequences
- **Arms race dynamics**: Evolution in action
- **Statistical inference**: Hypothesis testing in biology

### Cool/Wow Factor: 8/10

Seeing the tail fiber gene light up red (arms race!) while DNA polymerase is deep blue (essential!) makes evolution tangible.

### TUI Visualization

```
Selection Pressure: Lambda vs P22

Gene:     ──[CI]────[N]────[cro]────[O]────[P]────[gpJ tail fiber]──
dN/dS:    ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓
          └─ purifying (ω=0.1-0.3) ────────────────┘ └── positive! ──┘
                                                       (ω=2.8)

Legend: ░ Purifying (ω<0.5)  ▒ Neutral (0.5<ω<1.5)  ▓ Positive (ω>1.5)

Sliding window within gpJ:
   3.0 ┤                        ╭───╮  ← RBD hypervariable
   2.0 ┤                       ╭╯   ╰╮
   1.0 ┼─────────────────────────────────── ω = 1 (neutral)
   0.5 ┤ ╭───╮
   0.0 ┤─╯   ╰───────────────╯
       └─────────────────────────────────
         Anchor      Shaft        RBD
```

---

## 13) Lysogeny Decision Circuit Simulator

### Concept

The lambda phage **lysis-lysogeny decision** is biology's most famous genetic switch — a bistable circuit choosing between:
- **Lysogeny**: Integrate, repress lytic genes, wait for better times
- **Lysis**: Replicate, lyse cell, spread to new hosts

The decision is controlled by **CI** and **Cro** repressors in mutual competition. By modeling this with **ordinary differential equations** and visualizing the **phase portrait**, users can:
- Watch the decision unfold in real-time
- Understand how parameters (MOI, UV damage) affect outcomes
- See bistability and hysteresis in action
- Predict effects of mutations

### Mathematical Foundations

**ODE model:**
```
dCI/dt = α₁ · f(CI, Cro) - δ₁ · CI
dCro/dt = α₂ · g(CI, Cro) - δ₂ · Cro

Where:
f(CI, Cro) = (CI²/(K₁² + CI²)) × (K₂ⁿ/(K₂ⁿ + Croⁿ))
  // CI activates itself (positive feedback)
  // Cro represses CI

g(CI, Cro) = K₃ᵐ/(K₃ᵐ + CIᵐ)
  // CI represses Cro

Parameters: α (production), δ (degradation), K (thresholds), n,m (cooperativity)
```

**Phase portrait analysis:**
```
Fixed points where dCI/dt = 0 AND dCro/dt = 0:
  - Lysogenic state: High CI, low Cro (stable)
  - Lytic state: Low CI, high Cro (stable)
  - Saddle point: Medium CI, medium Cro (unstable)

Separatrix: Boundary between basins of attraction
  - Initial conditions on one side → lysogeny
  - Other side → lysis
```

**Bifurcation analysis:**
```
As δ₁ increases (UV damage degrades CI):
  - Lysogenic fixed point disappears
  - System forced into lysis (prophage induction)
```

### Implementation Approach

**Runge-Kutta 4th order integrator:**
```typescript
function rk4(
  deriv: (t: number, y: number[]) => number[],
  y0: number[],
  t0: number,
  tf: number,
  dt: number
): { t: number[]; y: number[][] } {
  const trajectory: number[][] = [y0];
  const times: number[] = [t0];
  let y = [...y0], t = t0;

  while (t < tf) {
    const k1 = deriv(t, y);
    const k2 = deriv(t + dt/2, y.map((yi, i) => yi + dt/2 * k1[i]));
    const k3 = deriv(t + dt/2, y.map((yi, i) => yi + dt/2 * k2[i]));
    const k4 = deriv(t + dt, y.map((yi, i) => yi + dt * k3[i]));
    y = y.map((yi, i) => yi + dt/6 * (k1[i] + 2*k2[i] + 2*k3[i] + k4[i]));
    t += dt;
    trajectory.push([...y]);
    times.push(t);
  }
  return { t: times, y: trajectory };
}
```

**Circuit model:**
```typescript
interface LysogenyParams {
  alpha1: number; alpha2: number;  // Production rates
  delta1: number; delta2: number;  // Degradation rates
  K1: number; K2: number; K3: number;  // Thresholds
  n: number; m: number;  // Hill coefficients
}

function lysogenyODE(params: LysogenyParams) {
  return (t: number, y: number[]): number[] => {
    const [CI, Cro] = y;

    const ciActivation = CI**2 / (params.K1**2 + CI**2);
    const croRepression = params.K2**params.n / (params.K2**params.n + Cro**params.n);
    const ciRepression = params.K3**params.m / (params.K3**params.m + CI**params.m);

    return [
      params.alpha1 * ciActivation * croRepression - params.delta1 * CI,
      params.alpha2 * ciRepression - params.delta2 * Cro
    ];
  };
}
```

**Phase portrait generation:**
```typescript
function computePhasePortrait(params: LysogenyParams, resolution = 20) {
  const ode = lysogenyODE(params);
  const vectorField = [];

  for (let i = 0; i <= resolution; i++) {
    for (let j = 0; j <= resolution; j++) {
      const ci = i / resolution * 2;
      const cro = j / resolution * 1;
      const [dci, dcro] = ode(0, [ci, cro]);
      vectorField.push({ x: ci, y: cro, dx: dci, dy: dcro });
    }
  }

  return { vectorField, fixedPoints: findFixedPoints(ode) };
}
```

### Why This Is a Good Idea

1. **Iconic biology**: Lambda switch is in every molecular biology textbook
2. **Systems biology gateway**: Perfect introduction to mathematical modeling
3. **Interactive learning**: Adjust parameters, observe consequences
4. **Beautiful mathematics**: Bistability, bifurcations, phase portraits
5. **Research relevance**: Understand prophage induction, synthetic biology

### Innovation Assessment

**Novelty: HIGH**

Mathematical models of lambda exist, but:
- No interactive TUI exploration
- No real-time parameter adjustment
- No connection to actual gene sequence/annotation
- No ASCII phase portrait visualization

### Pedagogical Value: 10/10

Teaches:
- **Systems biology**: Genes as circuits, not just sequences
- **Differential equations**: Biology as dynamical systems
- **Bistability**: How cells make binary decisions
- **Cooperativity**: Why Hill coefficients matter
- **Noise**: Stochastic effects in gene expression

### Cool/Wow Factor: 10/10

Watching trajectories spiral toward fixed points — seeing the "decision" unfold — is mesmerizing. Parameter sliders make it feel like a simulation game.

### TUI Visualization

```
Lysogeny Decision Phase Portrait

Cro ↑  · · · → → → → ╲ ╲ ╲ ↓ ↓ ↓ ↓ ↓ ·
    │  · · · → → → ╲ ╲ ╲ ↓ ↓ ↓ ↓ ↓ ↓ ·
    │  · · → → → ╲ ╲ ╲ ╲ ↓ ↓ ↓ ↓ ↓ · ·
    │  · → → → ╲ ╲ ╲ ╲ ↓ ↓ ↓ ↓ ↓ · · ·
    │  · → → → ╲ ╲ ╲ [●LYSIS] ↓ · · · ·    ● = stable
    │  · → → → ╲ ╲ ╲ ╲ ↓ ↓ ↓ · · · · ·
    │  · · → → → ╲ ╲ ╲ ╲ ↓ ↓ · · · · ·
    │  · · · → → → ╲ ╲ ╳ · · · · · · ·    ╳ = saddle
    │  · · · · → → → · ⊙ · · · · · · ·    ⊙ = current
    │  · · · · · · [●LYSOGENY] · · · ·
    ╰────────────────────────────────→ CI

Current: ⊙ (CI=1.2, Cro=0.3) → Lysogeny trajectory

Parameters:
  MOI: [████░░░░░░] 2.0    UV damage: [██░░░░░░░░] low
  [▶ Simulate] [↻ Reset] [⚙ Advanced]
```

---

## 14) Information-Theoretic Sequence Anomaly Scanner

### Concept

Every genome has a statistical "signature" — characteristic k-mer frequencies, compositional biases, and complexity patterns. **Anomalies** in this signature reveal:
- **Recent horizontal transfer**: Different composition from foreign source
- **Regulatory elements**: Low complexity but high information content
- **Repetitive regions**: High compression potential
- **Novel features**: Deviations that don't fit any model

Using **algorithmic information theory** (Kolmogorov complexity via compression, Shannon entropy, KL divergence), we find regions that "don't belong" — the surprises in the genome.

### Mathematical Foundations

**Kolmogorov complexity approximation:**
```
K(x) ≈ length(gzip(x))  // Compressed size approximates algorithmic complexity

Normalized: NC(x) = K̂(x) / length(x)
  Low NC = repetitive/simple
  High NC = complex/random
```

**Shannon entropy:**
```
H(X) = -Σ p(x) × log₂(p(x))

For DNA: max H = 2 bits/base (if A=C=G=T=0.25)
Typical genome: H ≈ 1.8-1.95 bits/base
```

**KL divergence for anomaly detection:**
```
D_KL(P || Q) = Σ P(x) × log(P(x) / Q(x))

Compare local k-mer distribution (P) to genome-wide (Q):
  High D_KL = local region differs from genome background
  = potential HGT, regulatory element, or novel feature
```

### Implementation Approach

**Compression-based complexity:**
```typescript
import pako from 'pako';

function compressionComplexity(sequence: string): number {
  const input = new TextEncoder().encode(sequence);
  const compressed = pako.deflate(input, { level: 9 });
  return compressed.length / input.length;
}

function slidingComplexity(
  sequence: string,
  windowSize = 1000,
  stepSize = 100
): { position: number; complexity: number }[] {
  const results = [];
  for (let i = 0; i <= sequence.length - windowSize; i += stepSize) {
    results.push({
      position: i,
      complexity: compressionComplexity(sequence.slice(i, i + windowSize))
    });
  }
  return results;
}
```

**KL divergence anomaly detection:**
```typescript
function computeKmerDistribution(seq: string, k: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let i = 0; i <= seq.length - k; i++) {
    const kmer = seq.slice(i, i + k);
    counts.set(kmer, (counts.get(kmer) || 0) + 1);
  }
  // Normalize to probabilities
  const total = seq.length - k + 1;
  const dist = new Map<string, number>();
  for (const [kmer, count] of counts) {
    dist.set(kmer, count / total);
  }
  return dist;
}

function klDivergence(local: Map<string, number>, global: Map<string, number>): number {
  let kl = 0;
  for (const [kmer, p] of local) {
    const q = global.get(kmer) || 1e-10;  // Smoothing
    kl += p * Math.log(p / q);
  }
  return kl;
}

interface Anomaly {
  start: number;
  end: number;
  klDivergence: number;
  type: 'potential_HGT' | 'repetitive' | 'regulatory' | 'unknown';
}

function detectAnomalies(sequence: string, windowSize = 2000): Anomaly[] {
  const globalDist = computeKmerDistribution(sequence, 4);
  const anomalies: Anomaly[] = [];

  for (let i = 0; i < sequence.length - windowSize; i += windowSize / 2) {
    const window = sequence.slice(i, i + windowSize);
    const localDist = computeKmerDistribution(window, 4);
    const kl = klDivergence(localDist, globalDist);

    if (kl > 0.5) {  // Threshold
      const complexity = compressionComplexity(window);
      anomalies.push({
        start: i,
        end: i + windowSize,
        klDivergence: kl,
        type: complexity < 0.3 ? 'repetitive' : 'potential_HGT'
      });
    }
  }

  return mergeOverlapping(anomalies);
}
```

### Why This Is a Good Idea

1. **Discovery-oriented**: Finds what you weren't looking for
2. **Annotation-independent**: Pure signal from sequence statistics
3. **HGT detection**: Critical for understanding phage evolution
4. **Regulatory element identification**: Promoters/terminators often anomalous
5. **Elegant mathematics**: Information theory in biology

### Innovation Assessment

**Novelty: HIGH**

Compression-based analysis exists in research, but:
- No integration with genome browsers
- No "anomaly scanner" visualization
- No classification of anomaly types
- Interactive exploration is novel

### Pedagogical Value: 8/10

Teaches:
- **Information theory**: Entropy, complexity, compression
- **Algorithmic information**: Kolmogorov complexity concepts
- **Compositional analysis**: Statistical signatures of sequences
- **HGT detection**: How foreign DNA is identified

### Cool/Wow Factor: 8/10

The idea of "finding surprises" using pure mathematics is intellectually exciting. An anomaly lighting up with "this looks foreign" is compelling.

### TUI Visualization

```
Information-Theoretic Profile: Lambda phage

Kolmogorov complexity (compression ratio):
  1.0 ┤──────────────────────────────────────────────────────
  0.8 ┤  ╭────────────╮      ╭───────────────╮    ╭─────────╮
  0.6 ┤──╯            ╰──────╯               ╰────╯         ╰
  0.4 ┤
  0.2 ┤                                            ╭───╮
  0.0 ┤────────────────────────────────────────────╯   ╰────
                    att site    normal region      repeat

KL divergence (compositional anomaly):
  2.0 ┤                    ╭─╮              ╭───╮
  1.5 ┤                   ╭╯ ╰╮            ╭╯   ╰╮
  1.0 ┤──────────────────╯    ╰────────────╯     ╰──────────
  0.5 ┤
      └───────────────────────────────────────────────────────
               ↑ HGT?           ↑ Regulatory island?

Detected anomalies:
  [12,450 - 14,200] KL=1.8 Type: potential_HGT    ⚠
  [38,100 - 38,800] KL=0.9 Type: repetitive       ○
```

---

## 15) Auxiliary Metabolic Gene (AMG) Hijacking Mapper

### Concept

Phages aren't just parasites — they're **metabolic engineers**. Many carry **Auxiliary Metabolic Genes (AMGs)** that reprogram host metabolism:
- **Photosynthesis** (psbA, psbD): Boost photosynthesis in cyanophages
- **Nucleotide synthesis**: Increase dNTP pools for viral replication
- **Carbon metabolism**: Redirect resources to phage production
- **Stress response**: Protect host long enough to complete infection

By mapping AMGs onto metabolic pathways, we visualize how phages **hijack** their hosts.

### Mathematical Foundations

**HMM profile matching (KOfam):**
```
KEGG Orthology provides HMM profiles for metabolic genes.
For each phage protein:
  Score against KOfam profiles
  Assign KO if E-value < threshold
```

**Pathway enrichment (hypergeometric test):**
```
For AMGs with KO assignments:
  For each KEGG pathway P:
    k = number of AMGs in P
    K = total AMGs
    M = genes in pathway P (background)
    N = total genes

    P-value = Σ C(M,x) × C(N-M, K-x) / C(N, K)  for x ≥ k

Enriched if P < 0.05 (Bonferroni corrected)
```

### Implementation Approach

**Simplified KO assignment without HMMER:**
```typescript
// Pre-computed k-mer signatures for metabolic gene families
const KO_SIGNATURES: Map<string, { kmers: Set<string>; pathway: string }> =
  loadKOSignatures();

interface AMGAnnotation {
  geneId: string;
  KO: string;
  pathway: string;
  confidence: number;
}

function assignKO(protein: string): AMGAnnotation | null {
  const proteinKmers = new Set<string>();
  for (let i = 0; i <= protein.length - 5; i++) {
    proteinKmers.add(protein.slice(i, i + 5));
  }

  let bestKO: string | null = null;
  let bestScore = 0;

  for (const [ko, { kmers, pathway }] of KO_SIGNATURES) {
    let intersection = 0;
    for (const kmer of proteinKmers) {
      if (kmers.has(kmer)) intersection++;
    }
    const score = intersection / Math.min(proteinKmers.size, kmers.size);

    if (score > bestScore && score > 0.2) {
      bestScore = score;
      bestKO = ko;
    }
  }

  return bestKO ? { geneId: '', KO: bestKO, pathway: '', confidence: bestScore } : null;
}
```

**Pathway overlay:**
```typescript
interface PathwayNode {
  id: string;
  name: string;
  x: number;
  y: number;
  isAMG: boolean;
  phageGene?: string;
}

// Pre-defined pathway layouts for key pathways
const PATHWAY_LAYOUTS = new Map<string, PathwayNode[]>();

function overlayAMGs(pathwayId: string, amgs: AMGAnnotation[]): PathwayNode[] {
  const layout = structuredClone(PATHWAY_LAYOUTS.get(pathwayId)!);

  for (const node of layout) {
    const amg = amgs.find(a => a.KO === node.id);
    if (amg) {
      node.isAMG = true;
      node.phageGene = amg.geneId;
    }
  }

  return layout;
}
```

### Why This Is a Good Idea

1. **Cutting-edge science**: AMGs are hot research topic (discovered 2003)
2. **Ecosystem impact**: Phage AMGs affect global biogeochemical cycles
3. **Evolutionary insight**: Why carry metabolic genes at all?
4. **Therapeutic relevance**: AMGs might have unexpected effects
5. **Visualization gap**: No tool shows AMGs on pathway maps in TUI

### Innovation Assessment

**Novelty: MEDIUM-HIGH**

Tools like VIBRANT and DRAM detect AMGs, but:
- No interactive pathway visualization
- No integration with genome browser
- TUI pathway overlay is unique

### Pedagogical Value: 9/10

Teaches:
- **Viral manipulation**: Phages as metabolic engineers
- **Metabolic pathways**: KEGG and cellular metabolism
- **Ecology**: Viruses affect biogeochemical cycles
- **Systems biology**: Pathway-level thinking

### Cool/Wow Factor: 8/10

Seeing a metabolic pathway with phage enzymes highlighted — realizing the virus is rewiring the host — is profound.

### TUI Visualization

```
Carbon Metabolism with Cyanophage S-PM2 AMGs
═══════════════════════════════════════════════════════════════

       CO₂
        │
        ▼
   ┌─────────┐
   │RuBisCO  │  ← Host enzyme
   └────┬────┘
        │
        ▼
   ┌─────────┐     ╔═════════╗     ┌─────────┐
   │3-PGA    │────▶║  psbA   ║────▶│  NADPH  │
   └─────────┘     ╚════╤════╝     └─────────┘
                        │
                   PHAGE AMG!      → Enhanced photosynthesis
                   (PS II D1)        during infection
                        │
                        ▼
                   Pentose-P ──▶ dNTPs ──▶ Phage DNA

Legend: ─ Host enzyme  ║ Phage AMG  ▶ Metabolic flow

AMG inventory:
┌──────────┬───────────────────┬───────────────────┬───────┐
│ Gene     │ Function          │ Pathway           │ Conf  │
├──────────┼───────────────────┼───────────────────┼───────┤
│ psbA     │ PS II D1 protein  │ Photosynthesis    │ █████ │
│ psbD     │ PS II D2 protein  │ Photosynthesis    │ █████ │
│ talC     │ Transaldolase     │ Pentose-P         │ ████░ │
│ mazG     │ dNTP hydrolase    │ Nucleotide metab. │ ████░ │
└──────────┴───────────────────┴───────────────────┴───────┘

Pathway enrichment: Photosynthesis (p = 3.2e-8) ⚡
```

---

## 16) Promoter/RBS Strength Predictor

### Concept

Gene expression in prokaryotes is a two-stage process: **transcription** (DNA → RNA) initiated at promoters, and **translation** (RNA → protein) initiated at ribosome binding sites (RBS). The strength of these regulatory elements determines how much of each protein is made — and in phages, this controls the entire infection program.

**Promoter architecture:**
Bacterial sigma-70 promoters have two conserved hexamers recognized by RNA polymerase:
- **-35 box**: Consensus TTGACA, recognized by σ70 region 4.2
- **-10 box** (Pribnow box): Consensus TATAAT, where DNA melting begins
- **Spacer**: Optimal 17±1 bp; length affects box alignment with RNAP

The relationship isn't simple homology — it's biophysics. The -10 box must be AT-rich because A-T base pairs (2 hydrogen bonds) melt more easily than G-C pairs (3 bonds). The -35 box provides specificity; the -10 box provides strand opening.

**RBS architecture:**
The Shine-Dalgarno sequence (AGGAGG) base-pairs with the 3' end of 16S rRNA (anti-SD: 5'-CCUCCU-3'). This positions the ribosome's P-site over the start codon. Critical parameters:
- **SD strength**: Complementarity to anti-SD (ΔG of hybridization)
- **Spacing**: 5-10 nt between SD and start codon (optimal ~7)
- **Start codon**: AUG > GUG > UUG (efficiency ratio ~1.0 : 0.14 : 0.03)
- **mRNA structure**: Secondary structure occluding SD reduces translation

**Why this matters for phages:**
- **Temporal control**: Early genes have moderate promoters; late genes have strong promoters activated by phage factors
- **Stoichiometry**: Structural proteins need 100-1000× more expression than regulators
- **Host takeover**: Some phages replace host sigma factors entirely (T4's AsiA/MotA system)
- **Therapy design**: Predicting expression helps engineer reporter phages or therapeutic constructs

### Mathematical Foundations

**Position Weight Matrix (PWM) for Promoter Scoring:**
```
Given a multiple alignment of known promoters, compute:

PWM[b][i] = log₂(f(b,i) / p(b))

Where:
  f(b,i) = frequency of base b at position i (with pseudocount)
  p(b) = background frequency (0.25 for uniform)

Score a candidate sequence:
  S = Σᵢ PWM[seq[i]][i]

Higher scores = better match to consensus
```

**Information Content (IC) per position:**
```
IC(i) = 2 - H(i)    where H(i) = -Σ_b f(b,i) · log₂(f(b,i))

Maximum IC = 2 bits (completely conserved)
Minimum IC = 0 bits (all bases equally likely)
Total promoter IC typically 12-16 bits for functional promoters
```

**Thermodynamic RBS Model:**
The Salis Lab RBS Calculator uses free energy minimization:
```
ΔG_total = ΔG_mRNA-rRNA + ΔG_spacing + ΔG_start + ΔG_standby + ΔG_mRNA_structure

Where:
  ΔG_mRNA-rRNA = hybridization energy of SD to anti-SD
  ΔG_spacing = penalty for non-optimal spacing
  ΔG_start = bonus/penalty for start codon identity
  ΔG_standby = penalty for structured standby site
  ΔG_mRNA_structure = penalty for secondary structure

Translation Initiation Rate ∝ exp(-ΔG_total / RT)
```

**Nearest-neighbor thermodynamics for RNA:RNA:**
```
ΔG°37 for RNA:RNA hybridization (kcal/mol):

5'-AA-3' / 3'-UU-5' = -0.93    5'-AU-3' / 3'-UA-5' = -1.10
5'-UA-3' / 3'-AU-5' = -1.33    5'-CU-3' / 3'-GA-5' = -2.08
5'-GA-3' / 3'-CU-5' = -2.35    5'-GU-3' / 3'-CA-5' = -2.11
5'-CA-3' / 3'-GU-5' = -2.24    5'-GG-3' / 3'-CC-5' = -3.26
5'-CG-3' / 3'-GC-5' = -2.36    5'-GC-3' / 3'-CG-5' = -3.42

Stacking interactions dominate — adjacent base pairs matter more than individual bases
```

**Extended Pribnow Box Model (-10 box):**
```
Consensus: T₈₂A₈₉T₅₂A₅₉A₅₁T₉₆  (subscripts = % conservation in E. coli)

Extended -10 (TGn motif at -14/-15):
  - Allows promoters with weak -35 to still function
  - Contacted by σ70 region 3.0
  - TG = +3-4 kcal/mol binding energy
```

### Implementation Approach

```typescript
// Core types for promoter/RBS analysis
interface PromoterPrediction {
  position: number;           // Position of -35 box (relative to gene start)
  minus35Sequence: string;    // Actual -35 hexamer
  minus35Score: number;       // PWM score
  minus10Sequence: string;    // Actual -10 hexamer
  minus10Score: number;       // PWM score
  spacerLength: number;       // Distance between boxes
  spacerPenalty: number;      // Deviation from optimal
  extendedMinus10: boolean;   // Has TGn motif?
  totalScore: number;         // Combined score
  predictedStrength: 'weak' | 'moderate' | 'strong' | 'very_strong';
  transcriptsPerMinute: number;  // Estimated expression level
}

interface RBSPrediction {
  position: number;           // Position of SD start
  sdSequence: string;         // Shine-Dalgarno sequence
  antiSDComplement: string;   // Aligned anti-SD region
  hybridizationDG: number;    // ΔG of SD:anti-SD (kcal/mol)
  spacing: number;            // Distance to start codon
  spacingPenalty: number;     // Deviation from optimal
  startCodon: string;         // AUG/GUG/UUG
  startCodonPenalty: number;  // Non-AUG penalty
  mRNAStructure: number;      // ΔG of local structure (penalty)
  totalDG: number;            // Combined ΔG
  predictedStrength: 'very_weak' | 'weak' | 'moderate' | 'strong' | 'very_strong';
  proteinPerHour: number;     // Estimated translation rate
}

interface ExpressionPrediction {
  gene: GeneInfo;
  promoter: PromoterPrediction | null;
  rbs: RBSPrediction;
  combinedStrength: number;   // 0-100 scale
  expressionCategory: 'low' | 'medium' | 'high' | 'very_high';
  rank: number;               // Rank among all genes (1 = highest)
  biologicalRole: string;     // Inferred from expression level
}

// Position Weight Matrices from E. coli promoter alignments
const MINUS_35_PWM: number[][] = [
  // Position: 1     2     3     4     5     6
  /* A */   [-1.2, -1.8, -0.3, -1.5, -1.8, -0.8],
  /* C */   [-1.5, -1.8, -1.8, -0.5, -1.8, -1.8],
  /* G */   [-1.8, -1.0, -1.8, -1.8, -1.8, -1.8],
  /* T */   [ 1.5,  1.2,  0.8,  0.6,  1.5,  1.0],
];

const MINUS_10_PWM: number[][] = [
  // Position: 1     2     3     4     5     6
  /* A */   [-1.8,  1.4, -1.8,  1.2,  1.0, -1.8],
  /* C */   [-1.8, -1.8, -1.8, -1.8, -1.8, -1.8],
  /* G */   [-1.8, -1.8, -1.8, -1.8, -1.8, -1.8],
  /* T */   [ 1.4, -0.8,  1.5, -0.5, -0.3,  1.6],
];

// Anti-Shine-Dalgarno sequence (E. coli 16S rRNA 3' end)
const ANTI_SD = 'ACCUCCUUA';  // 3' to 5' orientation

// Nearest-neighbor parameters for RNA:RNA hybridization
const NN_PARAMS: Record<string, number> = {
  'AA/UU': -0.93, 'AU/UA': -1.10, 'UA/AU': -1.33, 'CU/GA': -2.08,
  'GA/CU': -2.35, 'GU/CA': -2.11, 'CA/GU': -2.24, 'GG/CC': -3.26,
  'CG/GC': -2.36, 'GC/CG': -3.42, 'UU/AA': -0.93, 'UG/AC': -2.11,
  'AG/UC': -2.08, 'AC/UG': -2.24, 'UC/AG': -2.35, 'CC/GG': -3.26,
};

function scorePromoter(upstream: string): PromoterPrediction | null {
  const baseIndex: Record<string, number> = { 'A': 0, 'C': 1, 'G': 2, 'T': 3 };
  let bestPrediction: PromoterPrediction | null = null;
  let bestScore = -Infinity;

  // Scan for -35 box positions
  for (let m35Start = 0; m35Start <= upstream.length - 45; m35Start++) {
    const minus35 = upstream.slice(m35Start, m35Start + 6);

    // Score -35 box
    let m35Score = 0;
    let valid = true;
    for (let i = 0; i < 6; i++) {
      const base = minus35[i];
      if (!(base in baseIndex)) { valid = false; break; }
      m35Score += MINUS_35_PWM[baseIndex[base]][i];
    }
    if (!valid) continue;

    // Try different spacer lengths (15-20 bp)
    for (let spacer = 15; spacer <= 20; spacer++) {
      const m10Start = m35Start + 6 + spacer;
      if (m10Start + 6 > upstream.length) continue;

      const minus10 = upstream.slice(m10Start, m10Start + 6);

      // Score -10 box
      let m10Score = 0;
      valid = true;
      for (let i = 0; i < 6; i++) {
        const base = minus10[i];
        if (!(base in baseIndex)) { valid = false; break; }
        m10Score += MINUS_10_PWM[baseIndex[base]][i];
      }
      if (!valid) continue;

      // Spacer penalty (optimal = 17)
      const spacerPenalty = Math.pow(Math.abs(spacer - 17), 2) * 0.15;

      // Check for extended -10 (TGn at -14/-15)
      let extendedBonus = 0;
      if (m10Start >= 2) {
        const extended = upstream.slice(m10Start - 2, m10Start);
        if (extended === 'TG') extendedBonus = 2.0;
      }

      const totalScore = m35Score + m10Score - spacerPenalty + extendedBonus;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestPrediction = {
          position: m35Start - upstream.length, // Relative to gene start
          minus35Sequence: minus35,
          minus35Score: m35Score,
          minus10Sequence: minus10,
          minus10Score: m10Score,
          spacerLength: spacer,
          spacerPenalty,
          extendedMinus10: extendedBonus > 0,
          totalScore,
          predictedStrength: categorizePromoterStrength(totalScore),
          transcriptsPerMinute: estimateTranscriptionRate(totalScore),
        };
      }
    }
  }

  return bestPrediction;
}

function categorizePromoterStrength(score: number): PromoterPrediction['predictedStrength'] {
  if (score >= 8) return 'very_strong';
  if (score >= 5) return 'strong';
  if (score >= 2) return 'moderate';
  return 'weak';
}

function estimateTranscriptionRate(score: number): number {
  // Empirical relationship from promoter strength studies
  // Strong promoters: ~10-50 transcripts/min
  // Weak promoters: ~0.1-1 transcripts/min
  return Math.pow(10, score / 4) * 0.5;
}

function computeHybridizationEnergy(sd: string, antiSD: string): number {
  // Convert T to U for RNA
  const sdRNA = sd.replace(/T/g, 'U');
  const antiSDRNA = antiSD.replace(/T/g, 'U');

  // Compute ΔG using nearest-neighbor model
  let dG = 0;
  const initiation = 4.09; // Initiation penalty for RNA:RNA

  for (let i = 0; i < sdRNA.length - 1; i++) {
    const pair = `${sdRNA[i]}${sdRNA[i+1]}/${antiSDRNA[i]}${antiSDRNA[i+1]}`;
    dG += NN_PARAMS[pair] || 0;
  }

  return dG + initiation;
}

function scoreRBS(upstream: string, startCodon: string): RBSPrediction {
  let bestDG = Infinity;
  let bestPos = -1;
  let bestAlignment = { sd: '', antiSD: '' };

  // Search for SD sequence 5-15 nt upstream of start codon
  for (let sdEnd = upstream.length - 5; sdEnd >= upstream.length - 15 && sdEnd >= 4; sdEnd--) {
    // Try different SD lengths (4-6 nt)
    for (let len = 4; len <= 6 && sdEnd - len >= 0; len++) {
      const sd = upstream.slice(sdEnd - len, sdEnd);
      const antiSD = ANTI_SD.slice(0, len);

      const dG = computeHybridizationEnergy(sd, antiSD);

      if (dG < bestDG) {
        bestDG = dG;
        bestPos = sdEnd - len;
        bestAlignment = { sd, antiSD };
      }
    }
  }

  // Spacing penalty
  const spacing = upstream.length - (bestPos + bestAlignment.sd.length);
  const spacingPenalty = Math.pow(Math.abs(spacing - 7), 2) * 0.3;

  // Start codon penalty
  let startCodonPenalty = 0;
  if (startCodon === 'GTG') startCodonPenalty = 2.0;
  else if (startCodon === 'TTG') startCodonPenalty = 3.5;
  else if (startCodon !== 'ATG') startCodonPenalty = 5.0;

  const totalDG = bestDG + spacingPenalty + startCodonPenalty;

  return {
    position: bestPos,
    sdSequence: bestAlignment.sd,
    antiSDComplement: bestAlignment.antiSD,
    hybridizationDG: bestDG,
    spacing,
    spacingPenalty,
    startCodon,
    startCodonPenalty,
    mRNAStructure: 0, // Would need folding algorithm
    totalDG,
    predictedStrength: categorizeRBSStrength(totalDG),
    proteinPerHour: estimateTranslationRate(totalDG),
  };
}

function categorizeRBSStrength(dG: number): RBSPrediction['predictedStrength'] {
  if (dG <= -12) return 'very_strong';
  if (dG <= -8) return 'strong';
  if (dG <= -5) return 'moderate';
  if (dG <= -2) return 'weak';
  return 'very_weak';
}

function estimateTranslationRate(dG: number): number {
  // Translation rate inversely proportional to exp(ΔG/RT)
  const RT = 0.616; // kcal/mol at 37°C
  return 1000 * Math.exp(-dG / RT);
}

function analyzeGeneExpression(
  gene: GeneInfo,
  sequence: string,
  upstreamLength: number = 100
): ExpressionPrediction {
  // Get upstream region
  const start = Math.max(0, gene.start - upstreamLength);
  const upstream = sequence.slice(start, gene.start);

  // Get start codon
  const startCodon = sequence.slice(gene.start, gene.start + 3);

  // Score promoter and RBS
  const promoter = scorePromoter(upstream);
  const rbs = scoreRBS(upstream.slice(-30), startCodon);

  // Combined strength (0-100 scale)
  const promoterContrib = promoter ? Math.min(promoter.totalScore / 10 * 50, 50) : 25;
  const rbsContrib = Math.min(-rbs.totalDG / 15 * 50, 50);
  const combinedStrength = promoterContrib + rbsContrib;

  return {
    gene,
    promoter,
    rbs,
    combinedStrength,
    expressionCategory: categorizeExpression(combinedStrength),
    rank: 0, // Set after analyzing all genes
    biologicalRole: inferRole(combinedStrength, gene.product),
  };
}

function categorizeExpression(strength: number): ExpressionPrediction['expressionCategory'] {
  if (strength >= 80) return 'very_high';
  if (strength >= 60) return 'high';
  if (strength >= 40) return 'medium';
  return 'low';
}

function inferRole(strength: number, product: string | undefined): string {
  if (!product) {
    if (strength >= 80) return 'Likely structural protein (high abundance)';
    if (strength >= 40) return 'Possibly enzymatic (moderate expression)';
    return 'Regulatory or accessory (low expression)';
  }

  const lower = product.toLowerCase();
  if (lower.includes('capsid') || lower.includes('coat')) return 'Structural - capsid';
  if (lower.includes('tail')) return 'Structural - tail assembly';
  if (lower.includes('polymerase')) return 'Enzymatic - replication';
  if (lower.includes('lysin') || lower.includes('holin')) return 'Lysis machinery';
  if (lower.includes('repressor')) return 'Regulatory - lysogeny control';

  return 'Unknown function';
}
```

### Why This Is a Good Idea

1. **Decode the Temporal Program**: Phages execute precise gene expression cascades. Early genes (DNA replication) activate before late genes (structural proteins). Visualizing promoter/RBS strengths reveals this timing without experiments.

2. **Synthetic Biology Gateway**: Anyone designing reporter phages, CRISPR delivery vectors, or therapeutic constructs needs to predict expression levels. This makes Phage Explorer a design tool, not just a viewer.

3. **Discover Unusual Architectures**: Some phages have leaderless mRNAs (no SD), internal promoters, or use alternative sigma factors. Anomalies in prediction highlight these biologically interesting cases.

4. **Compare Host Adaptation**: Phages infecting different hosts (E. coli vs. Bacillus) use different promoter/RBS conventions. Seeing these differences reveals host-specific evolution.

5. **Identify Drug Targets**: The most highly expressed proteins are often essential and abundant — ideal targets for phage-based diagnostics or therapeutic interference.

### Innovation Assessment

**Novelty**: 6/10 — PWM scoring and RBS calculators exist (Salis Lab), but integrating them into a genome-wide TUI visualization with ranking and temporal prediction is new.

### Pedagogical Value: 9/10

Teaches:
- Central dogma and gene expression regulation
- Position weight matrices and information theory
- Thermodynamic principles of nucleic acid hybridization
- Nearest-neighbor energy models
- The hierarchical control of phage gene expression
- Why structural proteins dominate the proteome

### Cool/Wow Factor: 7/10

Seeing expression strength predicted for every gene — and watching how it correlates with function — makes the connection between sequence and biology visceral.

### TUI Visualization

```
┌─────────────────────────────────────────────────────────────────────────┐
│  GENE EXPRESSION PREDICTOR                          Lambda Phage       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Expression Rank (top 10 genes by predicted abundance)                  │
│  ═══════════════════════════════════════════════════════════════════    │
│  Rank  Gene      Function              Promoter  RBS     Combined      │
│  ────────────────────────────────────────────────────────────────────   │
│   1    gpE       Major capsid          ████████  █████   ██████████ 94 │
│   2    gpD       Decoration protein    ████████  ████░   █████████░ 88 │
│   3    gpFII     Tail shaft            ███████░  █████   █████████░ 85 │
│   4    gpV       Tail tube             ███████░  ████░   ████████░░ 79 │
│   5    gpJ       Tail fiber            ██████░░  █████   ████████░░ 76 │
│   6    gpB       Portal protein        ██████░░  ████░   ███████░░░ 71 │
│   7    gpNu1     Terminase small       █████░░░  ████░   ██████░░░░ 64 │
│   8    gpA       Terminase large       █████░░░  ███░░   █████░░░░░ 58 │
│   9    gpO       Replication           ████░░░░  ████░   █████░░░░░ 55 │
│  10    gpN       Antiterminator        ███░░░░░  ███░░   ████░░░░░░ 47 │
│                                                                         │
│  Gene Map with Expression Strength                                      │
│  ───────────────────────────────────────────────────────────────────    │
│  0kb        10kb       20kb       30kb       40kb       48kb           │
│  │──────────│──────────│──────────│──────────│──────────│              │
│                                                                         │
│  ░░░▒▒▒░░░░▒▒▒░░▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓██████████████░░░▒▒░░░░    │
│  ↑          ↑               ↑                    ↑            ↑        │
│  cI reg     replication     head genes           tail genes   lysis    │
│                                                                         │
│  Legend: ░ Low  ▒ Medium  ▓ High  █ Very High                          │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  Detail View: gpE (Major capsid protein)                               │
│  ═══════════════════════════════════════════════════════════════════    │
│                                                                         │
│  Promoter (-35 box)                     Promoter (-10 box)              │
│  Position: -42 to -37                   Position: -18 to -13            │
│  Sequence: TTGACT                       Sequence: TATAAC                │
│  Match:    TTGACA (5/6 = 83%)           Match:    TATAAT (5/6 = 83%)    │
│  Spacer: 17 bp (optimal)                Extended -10: Yes (TG at -15)   │
│                                                                         │
│  PWM alignment:                                                         │
│     -35        spacer             -10                                   │
│  ───TTGACT─────────────────────TG─TATAAC───────                         │
│     ││││ │                     ││ │││││                                 │
│     TTGACA (consensus)         TG TATAAT (consensus)                    │
│                                                                         │
│  RBS (Shine-Dalgarno)                                                   │
│  Position: -12 to -7                    Spacing: 7 bp (optimal)         │
│  Sequence: AGGAGG                       Start codon: AUG                │
│  Match:    AGGAGG (6/6 = 100%)          ΔG: -12.3 kcal/mol              │
│                                                                         │
│  SD alignment:                                                          │
│       mRNA 5'──────AGGAGG───7bp───AUG────────────3'                     │
│                    ||||||                                               │
│  16S rRNA 3'───────UCCUCC────────────────────────5'                     │
│                                                                         │
│  Predicted expression: VERY HIGH (94/100)                               │
│  Estimated abundance: ~500 copies per virion                            │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
[↑/↓] Select gene  [Enter] Details  [R] Rank by promoter/RBS  [E] Export
```

---

## 17) Structural Variation Detector

### Concept

Phage genomes are not static — they evolve through **large-scale structural rearrangements** that reshape chromosome architecture while sometimes preserving gene content. Unlike single nucleotide polymorphisms (SNPs) that change individual bases, structural variants (SVs) move, delete, duplicate, or flip entire genomic regions spanning hundreds to thousands of base pairs.

**Types of structural variation:**

1. **Deletions**: Regions present in one phage are absent in another. May remove non-essential genes (morons, AMGs) or arise from defective packaging.

2. **Insertions**: New sequences appear — often mobile genetic elements like HNH endonucleases, introns, or moron genes acquired from hosts or other phages.

3. **Inversions**: Genomic segments flip orientation. Common at recombination hotspots and in regions bounded by inverted repeats.

4. **Duplications**: Gene copy number increases. Can arise from replication slippage or unequal recombination. Tandem duplications are especially common.

5. **Translocations**: Genes maintain sequence but move to new positions. Often involve modular exchange between phage types.

6. **Complex rearrangements**: Combinations of the above, particularly in highly recombinogenic regions.

**Why structural variation matters in phages:**
- **Host range evolution**: Tail fiber gene shuffling allows host switching
- **Genome size variation**: Related phages can differ by 10-30% in size
- **Defense evasion**: Inversions can shuffle antigenic sites
- **Modularity evidence**: SVs reveal the "Lego block" nature of phage evolution
- **Therapy design**: Knowing which regions are stable vs. variable guides cocktail design

### Mathematical Foundations

**Locally Collinear Blocks (LCBs):**
```
An LCB is a maximal region of homologous sequence that appears in all
compared genomes without internal rearrangements.

Given genomes G₁, G₂, ..., Gₙ:
  LCB = { (s₁,e₁), (s₂,e₂), ..., (sₙ,eₙ) }

Where:
  sᵢ,eᵢ = start,end coordinates in genome i
  All regions are collinear (same order, same strand) or
  consistently inverted (all reversed)
```

**Breakpoint Distance:**
```
The number of rearrangement operations needed to transform one
gene order into another.

For signed permutations (genes with orientation):
  d(π₁, π₂) = n + 1 - c(π₁ · π₂⁻¹)

Where:
  n = number of genes
  c = number of cycles in the breakpoint graph
  π₁ · π₂⁻¹ = composition of permutations
```

**Double Cut and Join (DCJ) Distance:**
```
Generalized rearrangement distance allowing:
  - Inversions
  - Translocations
  - Fissions (chromosome breaks)
  - Fusions (chromosome joins)

DCJ distance = n - (c + i/2)

Where:
  n = number of adjacencies
  c = number of cycles in adjacency graph
  i = number of odd paths
```

**Alignment Block Chaining:**
```
Given pairwise alignments (anchors), find optimal colinear chain:

Score(chain) = Σᵢ score(anchorᵢ) - Σᵢ gap_penalty(anchorᵢ, anchorᵢ₊₁)

Solve with dynamic programming in O(n log n) using:
  - Segment trees for range-max queries
  - Sparse dynamic programming
```

**Copy Number Variation Detection:**
```
For k-mer or read depth analysis:

Expected depth at position i: λᵢ
Observed depth: dᵢ

Copy number: CN = round(dᵢ / median(d))

Statistical test (Poisson):
  P(d ≥ dᵢ | λ) = 1 - Σₖ₌₀^(dᵢ-1) (λᵏe⁻λ) / k!

Significant if P < threshold (Bonferroni-corrected)
```

### Implementation Approach

```typescript
// Comprehensive structural variation detection

interface AlignmentBlock {
  id: string;
  startA: number;        // Start in genome A
  endA: number;          // End in genome A
  startB: number;        // Start in genome B
  endB: number;          // End in genome B
  strand: '+' | '-';     // Orientation
  identity: number;      // Sequence identity (0-1)
  score: number;         // Alignment score
}

interface StructuralVariant {
  id: string;
  type: 'deletion' | 'insertion' | 'inversion' | 'duplication' |
        'translocation' | 'complex';
  confidence: 'high' | 'medium' | 'low';

  // Position in genome A
  positionA: { start: number; end: number } | null;
  // Position in genome B (if applicable)
  positionB: { start: number; end: number } | null;

  size: number;                    // Size of affected region
  affectedGenes: GeneInfo[];       // Genes in the region
  breakpointSequence?: string;     // Sequence at breakpoints
  mechanism?: string;              // Inferred mechanism

  // For duplications
  copyNumber?: number;

  // For inversions/translocations
  leftBreakpoint?: number;
  rightBreakpoint?: number;
}

interface SVAnalysisResult {
  phageA: { name: string; accession: string; length: number };
  phageB: { name: string; accession: string; length: number };
  alignmentBlocks: AlignmentBlock[];
  variants: StructuralVariant[];
  summary: {
    totalVariants: number;
    byType: Record<StructuralVariant['type'], number>;
    affectedBasesA: number;
    affectedBasesB: number;
    conservedFraction: number;
  };
  syntenyPlot: SyntenyData;
}

// Anchor-based alignment for SV detection
function findAlignmentAnchors(
  seqA: string,
  seqB: string,
  kmerSize: number = 15
): AlignmentBlock[] {
  // Build k-mer index for sequence B
  const index = new Map<string, number[]>();
  for (let i = 0; i <= seqB.length - kmerSize; i++) {
    const kmer = seqB.slice(i, i + kmerSize);
    if (!index.has(kmer)) index.set(kmer, []);
    index.get(kmer)!.push(i);
  }

  // Find exact matches (seeds)
  const seeds: Array<{ posA: number; posB: number; length: number }> = [];
  for (let i = 0; i <= seqA.length - kmerSize; i++) {
    const kmer = seqA.slice(i, i + kmerSize);
    const matches = index.get(kmer);
    if (matches) {
      for (const posB of matches) {
        // Extend seed in both directions
        let extendLeft = 0;
        let extendRight = 0;

        while (i - extendLeft > 0 && posB - extendLeft > 0 &&
               seqA[i - extendLeft - 1] === seqB[posB - extendLeft - 1]) {
          extendLeft++;
        }

        while (i + kmerSize + extendRight < seqA.length &&
               posB + kmerSize + extendRight < seqB.length &&
               seqA[i + kmerSize + extendRight] === seqB[posB + kmerSize + extendRight]) {
          extendRight++;
        }

        seeds.push({
          posA: i - extendLeft,
          posB: posB - extendLeft,
          length: kmerSize + extendLeft + extendRight
        });
      }
    }
  }

  // Also search reverse complement for inversions
  const seqBRC = reverseComplement(seqB);
  const indexRC = new Map<string, number[]>();
  for (let i = 0; i <= seqBRC.length - kmerSize; i++) {
    const kmer = seqBRC.slice(i, i + kmerSize);
    if (!indexRC.has(kmer)) indexRC.set(kmer, []);
    indexRC.get(kmer)!.push(i);
  }

  const rcSeeds: Array<{ posA: number; posB: number; length: number }> = [];
  for (let i = 0; i <= seqA.length - kmerSize; i++) {
    const kmer = seqA.slice(i, i + kmerSize);
    const matches = indexRC.get(kmer);
    if (matches) {
      for (const posRC of matches) {
        // Convert RC position back to forward strand
        const posB = seqB.length - posRC - kmerSize;
        rcSeeds.push({ posA: i, posB, length: kmerSize });
      }
    }
  }

  // Merge overlapping seeds and chain into blocks
  const forwardBlocks = chainSeeds(seeds, '+');
  const reverseBlocks = chainSeeds(rcSeeds, '-');

  return [...forwardBlocks, ...reverseBlocks].sort((a, b) => a.startA - b.startA);
}

function chainSeeds(
  seeds: Array<{ posA: number; posB: number; length: number }>,
  strand: '+' | '-'
): AlignmentBlock[] {
  if (seeds.length === 0) return [];

  // Sort by position in A
  const sorted = [...seeds].sort((a, b) => a.posA - b.posA);

  // Merge overlapping/adjacent seeds
  const merged: AlignmentBlock[] = [];
  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];
    const gapA = next.posA - (current.posA + current.length);
    const gapB = strand === '+'
      ? next.posB - (current.posB + current.length)
      : (current.posB - current.length) - next.posB;

    // Merge if gaps are small and consistent
    if (gapA < 50 && gapB < 50 && Math.abs(gapA - gapB) < 20) {
      current = {
        posA: current.posA,
        posB: current.posB,
        length: next.posA + next.length - current.posA
      };
    } else {
      if (current.length >= 100) { // Minimum block size
        merged.push({
          id: `block_${merged.length}`,
          startA: current.posA,
          endA: current.posA + current.length,
          startB: current.posB,
          endB: strand === '+' ? current.posB + current.length : current.posB - current.length,
          strand,
          identity: 0.95, // Approximate
          score: current.length
        });
      }
      current = next;
    }
  }

  // Don't forget the last block
  if (current.length >= 100) {
    merged.push({
      id: `block_${merged.length}`,
      startA: current.posA,
      endA: current.posA + current.length,
      startB: current.posB,
      endB: strand === '+' ? current.posB + current.length : current.posB - current.length,
      strand,
      identity: 0.95,
      score: current.length
    });
  }

  return merged;
}

function detectStructuralVariants(
  seqA: string,
  seqB: string,
  blocks: AlignmentBlock[],
  genesA: GeneInfo[],
  genesB: GeneInfo[]
): StructuralVariant[] {
  const variants: StructuralVariant[] = [];
  let variantId = 0;

  // Sort blocks by position in genome A
  const sorted = [...blocks].sort((a, b) => a.startA - b.startA);

  // Detect deletions and insertions (gaps between blocks)
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i];
    const next = sorted[i + 1];

    const gapA = next.startA - curr.endA;
    const gapB = Math.abs(next.startB - curr.endB);

    // Large gap in A, small gap in B = deletion in A
    if (gapA > 200 && gapB < 100) {
      variants.push({
        id: `sv_${variantId++}`,
        type: 'deletion',
        confidence: gapA > 1000 ? 'high' : 'medium',
        positionA: { start: curr.endA, end: next.startA },
        positionB: null,
        size: gapA,
        affectedGenes: findGenesInRegion(genesA, curr.endA, next.startA),
        mechanism: 'Deletion or horizontal transfer loss'
      });
    }

    // Small gap in A, large gap in B = insertion in A (or deletion in B)
    if (gapB > 200 && gapA < 100) {
      variants.push({
        id: `sv_${variantId++}`,
        type: 'insertion',
        confidence: gapB > 1000 ? 'high' : 'medium',
        positionA: { start: curr.endA, end: next.startA },
        positionB: { start: Math.min(curr.endB, next.startB), end: Math.max(curr.endB, next.startB) },
        size: gapB,
        affectedGenes: findGenesInRegion(genesB, Math.min(curr.endB, next.startB), Math.max(curr.endB, next.startB)),
        mechanism: 'Insertion or horizontal gene transfer'
      });
    }
  }

  // Detect inversions (blocks with opposite strand)
  const forwardBlocks = sorted.filter(b => b.strand === '+');
  const reverseBlocks = sorted.filter(b => b.strand === '-');

  for (const invBlock of reverseBlocks) {
    // Find flanking forward blocks
    const leftFlank = forwardBlocks.filter(b => b.endA <= invBlock.startA)
      .sort((a, b) => b.endA - a.endA)[0];
    const rightFlank = forwardBlocks.filter(b => b.startA >= invBlock.endA)
      .sort((a, b) => a.startA - b.startA)[0];

    if (leftFlank && rightFlank) {
      variants.push({
        id: `sv_${variantId++}`,
        type: 'inversion',
        confidence: invBlock.score > 500 ? 'high' : 'medium',
        positionA: { start: invBlock.startA, end: invBlock.endA },
        positionB: { start: Math.min(invBlock.startB, invBlock.endB),
                     end: Math.max(invBlock.startB, invBlock.endB) },
        size: invBlock.endA - invBlock.startA,
        affectedGenes: findGenesInRegion(genesA, invBlock.startA, invBlock.endA),
        leftBreakpoint: leftFlank.endA,
        rightBreakpoint: rightFlank.startA,
        mechanism: 'Inversion via homologous recombination'
      });
    }
  }

  // Detect duplications (overlapping blocks in B)
  const sortedByB = [...sorted].sort((a, b) => a.startB - b.startB);
  for (let i = 0; i < sortedByB.length - 1; i++) {
    const curr = sortedByB[i];
    const next = sortedByB[i + 1];

    // Overlapping regions in B = duplication
    if (curr.endB > next.startB && curr.strand === next.strand) {
      const overlapSize = curr.endB - next.startB;
      if (overlapSize > 100) {
        variants.push({
          id: `sv_${variantId++}`,
          type: 'duplication',
          confidence: overlapSize > 500 ? 'high' : 'medium',
          positionA: null,
          positionB: { start: next.startB, end: curr.endB },
          size: overlapSize,
          affectedGenes: findGenesInRegion(genesB, next.startB, curr.endB),
          copyNumber: 2,
          mechanism: 'Tandem duplication'
        });
      }
    }
  }

  // Detect translocations (out-of-order blocks)
  for (let i = 0; i < sorted.length - 1; i++) {
    const curr = sorted[i];
    const next = sorted[i + 1];

    // If B coordinates don't follow A order (for forward strand)
    if (curr.strand === '+' && next.strand === '+') {
      if (next.startB < curr.endB - 1000) { // Significant disorder
        variants.push({
          id: `sv_${variantId++}`,
          type: 'translocation',
          confidence: 'medium',
          positionA: { start: curr.endA, end: next.startA },
          positionB: { start: curr.endB, end: next.startB },
          size: Math.abs(next.startB - curr.endB),
          affectedGenes: [...findGenesInRegion(genesA, curr.endA, next.startA),
                         ...findGenesInRegion(genesB, Math.min(curr.endB, next.startB),
                                             Math.max(curr.endB, next.startB))],
          mechanism: 'Genomic translocation'
        });
      }
    }
  }

  return variants;
}

function findGenesInRegion(genes: GeneInfo[], start: number, end: number): GeneInfo[] {
  return genes.filter(g =>
    (g.start >= start && g.start < end) ||
    (g.end > start && g.end <= end) ||
    (g.start < start && g.end > end)
  );
}

function reverseComplement(seq: string): string {
  const complement: Record<string, string> = {
    'A': 'T', 'T': 'A', 'G': 'C', 'C': 'G',
    'a': 't', 't': 'a', 'g': 'c', 'c': 'g',
    'N': 'N', 'n': 'n'
  };
  return seq.split('').reverse().map(c => complement[c] || c).join('');
}

function generateSVSummary(variants: StructuralVariant[]): string[] {
  const summary: string[] = [];

  const byType = new Map<string, StructuralVariant[]>();
  for (const v of variants) {
    if (!byType.has(v.type)) byType.set(v.type, []);
    byType.get(v.type)!.push(v);
  }

  for (const [type, svs] of byType) {
    const totalSize = svs.reduce((sum, sv) => sum + sv.size, 0);
    const affectedGenes = new Set(svs.flatMap(sv => sv.affectedGenes.map(g => g.name || g.locus_tag)));

    summary.push(`${type.toUpperCase()}: ${svs.length} events, ${totalSize.toLocaleString()} bp, ${affectedGenes.size} genes`);
  }

  return summary;
}
```

### Why This Is a Good Idea

1. **Reveals Modular Evolution**: Phages evolve by shuffling functional modules. SVs show exactly which blocks are mobile and which are conserved, illuminating the "Lego block" model of phage evolution.

2. **Identifies Variable Regions**: Host range determinants (tail fibers), auxiliary genes (morons), and immunity regions are often SV hotspots. This guides rational phage cocktail design.

3. **Detects Cryptic Homology**: Inversions can hide sequence similarity from standard BLAST. Detecting SVs reveals relationships invisible to naive comparison.

4. **Evolutionary Distance Proxy**: DCJ distance and breakpoint counts quantify genomic divergence independently of sequence identity — useful when sequences are too diverged for alignment.

5. **Defective Prophage Archaeology**: Integrated prophages accumulate deletions. SV detection reconstructs what the ancestral prophage looked like before decay.

### Innovation Assessment

**Novelty**: 7/10 — Mauve and progressiveMauve pioneered this for bacteria, but phage-specific SV visualization with gene annotation and mechanism inference in a TUI is new.

### Pedagogical Value: 8/10

Teaches:
- Genome rearrangement theory and DCJ model
- The difference between sequence and structural divergence
- Anchor-based whole-genome alignment
- Recombination mechanisms (NHEJ, HR, replication slippage)
- The modular nature of phage genomes
- Copy number variation and its detection

### Cool/Wow Factor: 8/10

Watching related phage genomes "rearrange" in real-time — seeing inversions flip, deletions carve out genes, and translocations shuffle modules — makes evolution visceral and immediate.

### TUI Visualization

```
┌─────────────────────────────────────────────────────────────────────────┐
│  STRUCTURAL VARIATION DETECTOR                Lambda vs P22             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Whole-Genome Alignment (Synteny Plot)                                  │
│  ═══════════════════════════════════════════════════════════════════    │
│                                                                         │
│  Lambda    0kb    10kb    20kb    30kb    40kb    48kb                  │
│            │───────│───────│───────│───────│───────│                    │
│            ════════╗       ╭───────────────────────╮                    │
│                    ║       │  Forward homology     │                    │
│                    ║   ╔═══╧═══════════════════════╧════╗               │
│                    ║   ║ ← Inversion (att region) →     ║               │
│                    ║   ╚═══╤═══════════════════════╤════╝               │
│                    ║       │                       │                    │
│            ════════╝       ╰───────────────────────╯                    │
│  P22       │───────│───────│───────│───────│───────│                    │
│            0kb    10kb    20kb    30kb    40kb    41kb                  │
│                                                                         │
│  Color key: ══ Forward alignment  ═╗╔═ Inversion  ▓▓ Deleted  ░░ Inserted │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  Detected Structural Variants (7 total)                                 │
│  ═══════════════════════════════════════════════════════════════════    │
│                                                                         │
│  Type          Position       Size      Genes Affected       Confidence │
│  ─────────────────────────────────────────────────────────────────────  │
│  INVERSION     12,340-18,560  6,220 bp  int, xis, ea10      ★★★ High   │
│  DELETION      24,100-28,450  4,350 bp  nin region (5)      ★★★ High   │
│  INSERTION     —              3,200 bp  P22 ant moron       ★★☆ Med    │
│  DUPLICATION   31,000-32,500  1,500 bp  sieB immunity       ★★☆ Med    │
│  TRANSLOCATION 8,200-10,100   1,900 bp  ea22, ea31          ★☆☆ Low    │
│  DELETION      38,500-39,200    700 bp  hypothetical        ★★☆ Med    │
│  INSERTION     —              1,100 bp  Lambda Q regulator  ★★★ High   │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  Inversion Detail: int-xis region                                       │
│  ═══════════════════════════════════════════════════════════════════    │
│                                                                         │
│  Lambda:  ─────▶[att]▶[int]▶[xis]▶[ea10]▶─────                          │
│                    └────────────────┘                                   │
│                       Inverted in P22                                   │
│  P22:     ─────◀[ea10]◀[xis]◀[int]◀[att]◀─────                          │
│                                                                         │
│  Left breakpoint:  5'-GCTTTTTAT|ACTAAGCA-3' (attL core)                 │
│  Right breakpoint: 5'-TGCTTTTT|TATACTAA-3' (attR core)                  │
│                                                                         │
│  Mechanism: Site-specific recombination at att sites                    │
│  Biological impact: May affect lysogeny efficiency                      │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  Summary Statistics                                                     │
│  ═══════════════════════════════════════════════════════════════════    │
│                                                                         │
│  Conserved synteny:     ███████████████████░░░░ 78%                     │
│  Structural divergence: █████░░░░░░░░░░░░░░░░░░ 22%                     │
│                                                                         │
│  Breakpoint distance: 7 operations                                      │
│  DCJ distance: 5 operations                                             │
│                                                                         │
│  Largest conserved block: 18,450 bp (head-tail structural module)       │
│  Most variable region: 12-28 kb (lysogeny control)                      │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
[←/→] Navigate variants  [Enter] Detail view  [S] Synteny mode  [E] Export
```

---

## 18) Prophage Excision Precision Mapper

### Concept

For temperate phages, predict the exact **attL** and **attR** sites that flank the integrated prophage, and model the excision product.

### Implementation

```typescript
interface AttSites {
  attL: { sequence: string; position: number };
  attR: { sequence: string; position: number };
  attB: string;  // Reconstituted bacterial site
  attP: string;  // Reconstituted phage site
  integrase: Gene;
}

function findAttSites(
  prophageRegion: string,
  genes: Gene[]
): AttSites | null {
  // Find integrase gene
  const integrase = genes.find(g =>
    g.product?.toLowerCase().includes('integrase') ||
    g.product?.toLowerCase().includes('recombinase')
  );

  if (!integrase) return null;

  // Search for imperfect direct repeats at prophage boundaries
  const leftFlank = prophageRegion.slice(0, 500);
  const rightFlank = prophageRegion.slice(-500);

  const repeats = findImperfectRepeats(leftFlank, rightFlank, {
    minLength: 15,
    maxMismatches: 3
  });

  if (repeats.length === 0) return null;

  const best = repeats[0];

  return {
    attL: { sequence: best.left, position: best.leftPos },
    attR: { sequence: best.right, position: best.rightPos },
    attB: reconstructAttB(best.left, best.right),
    attP: reconstructAttP(best.left, best.right),
    integrase
  };
}
```

### TUI Visualization

```
Prophage excision prediction: Lambda

Integrated state:
────[gal]───[attL]════[λ prophage]════[attR]───[bio]────
              │                          │
              GCTTTTTTATACTAA             GCTTTTTTATACTAA
              (core sequence)

              ↓ Int-mediated excision

Excised products:
Chromosome: ────[gal]───[attB]───[bio]────  (restored)
                         │
                    GCTTTTTTATACTAA

Lambda circle:     ╭──[attP]──╮
                   │          │
                   ╰──────────╯
```

---

## 19) Virion Stability Predictor

### Concept

Predict phage particle stability (temperature, pH, ionic strength) from capsid protein properties — critical for therapy formulation.

### Implementation

```typescript
interface StabilityProfile {
  temperatureRange: { min: number; max: number; optimal: number };
  pHRange: { min: number; max: number; optimal: number };
  ionicSensitivity: 'low' | 'medium' | 'high';
  shelfLife: string;
  concerns: string[];
}

function predictStability(capsidProteins: Protein[]): StabilityProfile {
  // Aggregate properties across structural proteins
  let totalCharge = 0;
  let hydrophobicFraction = 0;
  let cysteineCount = 0;
  let totalLength = 0;

  for (const protein of capsidProteins) {
    const props = computeProteinProperties(protein.sequence);
    totalCharge += props.netCharge;
    hydrophobicFraction += props.hydrophobicFraction * protein.sequence.length;
    cysteineCount += (protein.sequence.match(/C/g) || []).length;
    totalLength += protein.sequence.length;
  }

  hydrophobicFraction /= totalLength;
  const chargePerResidue = totalCharge / totalLength;

  // Empirical rules from literature
  const tempMax = 55 + cysteineCount * 2;  // Disulfides stabilize
  const pHMin = chargePerResidue > 0.1 ? 5 : 4;
  const pHMax = chargePerResidue < -0.1 ? 9 : 10;

  return {
    temperatureRange: { min: 4, max: tempMax, optimal: 20 },
    pHRange: { min: pHMin, max: pHMax, optimal: 7 },
    ionicSensitivity: hydrophobicFraction > 0.4 ? 'high' : 'medium',
    shelfLife: tempMax > 60 ? '12+ months' : '6-12 months',
    concerns: []
  };
}
```

### TUI Visualization

```
Virion Stability: T4 phage

Temperature:  ████████████░░░░░░░░  (stable to 55°C)
pH tolerance: ░░░████████████████░  (pH 5-9)
Ionic sens.:  ████░░░░░░░░░░░░░░░░  (low sensitivity)

Recommendation: Store at 4°C in SM buffer (pH 7.5)
Shelf life: ~12 months with <1 log loss

⚠ Concerns: None identified
```

---

## 20) Comparative Synteny Browser

### Concept

Visualize gene order conservation across multiple phages with rearrangement highlighting.

### Implementation

```typescript
interface SyntenyBlock {
  phages: string[];
  genes: Map<string, Gene[]>;  // phageId -> genes in block
  conserved: boolean;
  rearrangement?: 'inversion' | 'translocation';
}

function computeSynteny(phages: PhageFull[]): SyntenyBlock[] {
  // Build ortholog clusters
  const orthologs = clusterOrthologs(phages.flatMap(p => p.genes));

  // Find conserved blocks (same order across phages)
  const blocks: SyntenyBlock[] = [];

  // Walk through first phage, extend blocks while order conserved
  const reference = phages[0];
  let currentBlock: Gene[] = [];

  for (const gene of reference.genes) {
    const cluster = orthologs.get(gene.id);
    if (!cluster) continue;

    // Check if order conserved in all phages
    const conservedInAll = phages.every(p =>
      isOrderConserved(cluster, p.genes, currentBlock)
    );

    if (conservedInAll) {
      currentBlock.push(gene);
    } else {
      if (currentBlock.length > 0) {
        blocks.push(createBlock(currentBlock, phages));
      }
      currentBlock = [gene];
    }
  }

  return blocks;
}
```

### TUI Visualization

```
Synteny: Lambda vs P22 vs HK97

Lambda: ═[cI]═[N]═[cro]═══════════[head]════════[tail]═══════[lysis]═
             │   │                  │             │            │
P22:    ═════╪═══╪══════════════════╪═════════════╪════════════╪═════
             │   │                  │             │            │
HK97:   ═════╪═══╪══════════════════╪════[portal]═╪════════════╪═════
             │   │                  │      ↑      │            │
             └───┴──────────────────┴──────┼──────┴────────────┘
                  conserved regulatory      gene insertion
                  module across all 3

Legend: ═ Conserved synteny  ╪ Block boundary  ↑ Insertion/rearrangement
```

---

## 21) Sequence Logo Generator

### Concept

Create information-theoretic **sequence logos** from multiple sequence alignments — the standard for visualizing conserved motifs.

### Implementation

```typescript
interface LogoColumn {
  position: number;
  totalBits: number;  // Information content (max 2 for DNA, 4.3 for protein)
  letters: { char: string; height: number }[];  // Sorted by height
}

function generateLogo(alignment: string[], type: 'dna' | 'protein'): LogoColumn[] {
  const maxBits = type === 'dna' ? 2 : Math.log2(20);
  const length = alignment[0].length;
  const columns: LogoColumn[] = [];

  for (let pos = 0; pos < length; pos++) {
    const counts = new Map<string, number>();
    let total = 0;

    for (const seq of alignment) {
      const char = seq[pos];
      if (char !== '-') {
        counts.set(char, (counts.get(char) || 0) + 1);
        total++;
      }
    }

    // Shannon entropy
    let entropy = 0;
    for (const count of counts.values()) {
      const p = count / total;
      entropy -= p * Math.log2(p);
    }

    const information = maxBits - entropy;

    // Letter heights proportional to frequency × information
    const letters = Array.from(counts.entries())
      .map(([char, count]) => ({
        char,
        height: (count / total) * information
      }))
      .sort((a, b) => a.height - b.height);  // Stack smallest at bottom

    columns.push({ position: pos, totalBits: information, letters });
  }

  return columns;
}
```

### TUI Visualization

```
Promoter -10 box consensus logo:

Bits
 2.0 ┤     T
     │     T A A A
 1.5 ┤     T A A A T
     │   T T A A A T
 1.0 ┤   T T A A A T
     │   T T A A A T
 0.5 ┤ T T T A A A T A
     │ T T T A A A T A T
 0.0 └─┴─┴─┴─┴─┴─┴─┴─┴─┴─
       1 2 3 4 5 6 7 8 9

Consensus: TATAAT (Pribnow box)
Information content: 8.2 bits (highly conserved)
```

---

## 22) Chaos Game Representation (CGR) Fractal Fingerprints

### Concept

The Chaos Game Representation transforms a linear DNA sequence into a two-dimensional fractal image that encodes the complete k-mer frequency spectrum in a single visual fingerprint. Originally developed by H. Joel Jeffrey in 1990, CGR exploits a remarkable mathematical property: each point in the resulting image corresponds exactly to a specific k-mer, and its brightness reflects that k-mer's frequency in the genome.

The algorithm is elegantly simple: assign each nucleotide to a corner of a unit square (A=top-left, T=top-right, G=bottom-right, C=bottom-left). Start at the center. For each nucleotide in the sequence, move halfway toward its designated corner and place a point. The resulting pattern reveals deep structural properties that are invisible in linear sequence views.

**Why this works**: After k steps, the point's location uniquely encodes the last k nucleotides seen. All sequences ending in "AAA" cluster in one region; all "GGC" endings cluster elsewhere. This means a single image captures **all k-mer frequencies simultaneously** — no need to choose k in advance.

**Biological insights revealed by CGR:**
- **CpG suppression**: In many organisms, CG dinucleotides are rare (methylation targets). This appears as a void in the CG corner region
- **Codon bias**: Highly expressed genes cluster in specific regions corresponding to preferred codons
- **Repetitive elements**: Appear as unusually bright spots (high local k-mer frequency)
- **Horizontal gene transfer**: Recent acquisitions have different k-mer signatures, appearing as texture discontinuities
- **Strand asymmetry**: Leading vs lagging strand preferences create asymmetric patterns

### Mathematical Foundations

**The CGR Iteration Map:**
```
Given nucleotide corners:
  A = (0, 0)    T = (1, 0)
  C = (0, 1)    G = (1, 1)

Starting point: P₀ = (0.5, 0.5)

For each nucleotide nᵢ in sequence:
  Pᵢ = (Pᵢ₋₁ + corner(nᵢ)) / 2

Or equivalently:
  Pᵢ = Pᵢ₋₁/2 + corner(nᵢ)/2
```

**K-mer to Coordinate Mapping:**
For a k-mer s₁s₂...sₖ, the CGR coordinate is:
```
x = Σᵢ₌₁ᵏ xᵢ / 2ⁱ   where xᵢ = corner_x(sᵢ)
y = Σᵢ₌₁ᵏ yᵢ / 2ⁱ   where yᵢ = corner_y(sᵢ)
```

This is a bijective mapping — every point in [0,1]² corresponds to a unique infinite k-mer, and finite k-mers map to distinct 2⁻ᵏ × 2⁻ᵏ cells.

**Frequency Chaos Game Representation (FCGR):**
Discretize the unit square into a 2ᵏ × 2ᵏ grid. Each cell counts occurrences of its corresponding k-mer:
```
FCGR[i,j] = count(k-mer corresponding to cell (i,j))

For k=3, grid is 8×8 = 64 cells (one per trinucleotide)
For k=4, grid is 16×16 = 256 cells (one per tetranucleotide)
```

**Fractal Dimension Analysis:**
The CGR image has a fractal structure. The correlation dimension D₂ measures sequence complexity:
```
D₂ = lim(ε→0) log(C(ε)) / log(ε)

where C(ε) = (1/N²) Σᵢⱼ I(|Pᵢ - Pⱼ| < ε)
```
- Random sequence: D₂ ≈ 2 (fills the plane uniformly)
- Repetitive sequence: D₂ < 2 (concentrates on attractors)
- Biased composition: D₂ < 2 (avoids certain regions)

**Distance Metrics for CGR Comparison:**
```
Euclidean distance between FCGRs:
  d(A,B) = √(Σᵢⱼ (FCGRₐ[i,j] - FCGRᵦ[i,j])²)

Pearson correlation (normalized):
  r(A,B) = Σᵢⱼ (Aᵢⱼ - μₐ)(Bᵢⱼ - μᵦ) / (σₐ σᵦ n²)

Kullback-Leibler divergence (asymmetric):
  KL(A||B) = Σᵢⱼ Aᵢⱼ log(Aᵢⱼ / Bᵢⱼ)
```

### Implementation Approach

**Core CGR Engine:**
```typescript
interface CGRConfig {
  resolution: number;      // Grid size (power of 2 recommended)
  normalize: boolean;      // Normalize by sequence length
  logScale: boolean;       // Log transform for visualization
  smoothing: number;       // Gaussian blur sigma (0 = none)
}

interface CGRResult {
  grid: Float32Array;      // Flattened 2D frequency grid
  resolution: number;
  maxCount: number;
  totalPoints: number;
  emptyFraction: number;   // Fraction of cells with count 0
  entropy: number;         // Shannon entropy of distribution
}

function computeCGR(sequence: string, config: CGRConfig): CGRResult {
  const { resolution, normalize, logScale, smoothing } = config;
  const grid = new Float32Array(resolution * resolution);

  // Corner coordinates
  const corners: Record<string, [number, number]> = {
    'A': [0, 0], 'T': [1, 0], 'G': [1, 1], 'C': [0, 1]
  };

  // Iterate through sequence
  let x = 0.5, y = 0.5;
  let validPoints = 0;

  for (const char of sequence.toUpperCase()) {
    const corner = corners[char];
    if (!corner) continue; // Skip N or other ambiguous bases

    x = (x + corner[0]) / 2;
    y = (y + corner[1]) / 2;

    const gridX = Math.min(Math.floor(x * resolution), resolution - 1);
    const gridY = Math.min(Math.floor(y * resolution), resolution - 1);
    grid[gridY * resolution + gridX]++;
    validPoints++;
  }

  // Statistics
  let maxCount = 0;
  let nonZeroCells = 0;
  let entropy = 0;

  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > 0) {
      nonZeroCells++;
      if (grid[i] > maxCount) maxCount = grid[i];
      const p = grid[i] / validPoints;
      entropy -= p * Math.log2(p);
    }
  }

  // Normalization
  if (normalize && validPoints > 0) {
    for (let i = 0; i < grid.length; i++) {
      grid[i] /= validPoints;
    }
  }

  // Log transform (improves visualization of rare k-mers)
  if (logScale) {
    for (let i = 0; i < grid.length; i++) {
      grid[i] = grid[i] > 0 ? Math.log1p(grid[i]) : 0;
    }
  }

  return {
    grid,
    resolution,
    maxCount,
    totalPoints: validPoints,
    emptyFraction: 1 - nonZeroCells / (resolution * resolution),
    entropy
  };
}

// Compare two CGRs
function compareCGR(a: CGRResult, b: CGRResult): {
  euclidean: number;
  pearson: number;
  cosineSimilarity: number;
} {
  if (a.resolution !== b.resolution) {
    throw new Error('CGR resolutions must match');
  }

  const n = a.grid.length;
  let sumA = 0, sumB = 0, sumAB = 0;
  let sumA2 = 0, sumB2 = 0;
  let euclideanSum = 0;

  for (let i = 0; i < n; i++) {
    sumA += a.grid[i];
    sumB += b.grid[i];
    sumAB += a.grid[i] * b.grid[i];
    sumA2 += a.grid[i] * a.grid[i];
    sumB2 += b.grid[i] * b.grid[i];
    euclideanSum += (a.grid[i] - b.grid[i]) ** 2;
  }

  const meanA = sumA / n;
  const meanB = sumB / n;

  // Pearson correlation
  let covSum = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const dA = a.grid[i] - meanA;
    const dB = b.grid[i] - meanB;
    covSum += dA * dB;
    varA += dA * dA;
    varB += dB * dB;
  }

  const pearson = covSum / (Math.sqrt(varA) * Math.sqrt(varB));
  const cosineSimilarity = sumAB / (Math.sqrt(sumA2) * Math.sqrt(sumB2));

  return {
    euclidean: Math.sqrt(euclideanSum),
    pearson,
    cosineSimilarity
  };
}
```

**Braille-Based TUI Rendering:**
```typescript
// Braille characters give 2x4 dots per character = 8x resolution boost
const BRAILLE_BASE = 0x2800;
const BRAILLE_DOTS = [
  [0x01, 0x08],  // Row 0: dots 1, 4
  [0x02, 0x10],  // Row 1: dots 2, 5
  [0x04, 0x20],  // Row 2: dots 3, 6
  [0x40, 0x80],  // Row 3: dots 7, 8
];

function renderCGRBraille(
  cgr: CGRResult,
  width: number,
  height: number,
  colorMap: (value: number) => string
): string[] {
  const { grid, resolution } = cgr;
  const lines: string[] = [];

  // Each character covers 2 columns and 4 rows of the grid
  const cellsPerCharX = Math.ceil(resolution / (width * 2));
  const cellsPerCharY = Math.ceil(resolution / (height * 4));

  // Find max for normalization
  let maxVal = 0;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] > maxVal) maxVal = grid[i];
  }

  for (let charY = 0; charY < height; charY++) {
    let line = '';

    for (let charX = 0; charX < width; charX++) {
      let brailleCode = BRAILLE_BASE;
      let avgValue = 0;
      let dotCount = 0;

      // Check each of the 8 dots in this Braille character
      for (let dotRow = 0; dotRow < 4; dotRow++) {
        for (let dotCol = 0; dotCol < 2; dotCol++) {
          const gridX = charX * 2 * cellsPerCharX + dotCol * cellsPerCharX;
          const gridY = charY * 4 * cellsPerCharY + dotRow * cellsPerCharY;

          if (gridX < resolution && gridY < resolution) {
            const value = grid[gridY * resolution + gridX];
            avgValue += value;
            dotCount++;

            // Threshold: dot is lit if value > 10% of max
            if (value > maxVal * 0.1) {
              brailleCode |= BRAILLE_DOTS[dotRow][dotCol];
            }
          }
        }
      }

      // Color based on average value in this cell
      avgValue = dotCount > 0 ? avgValue / dotCount : 0;
      const color = colorMap(avgValue / maxVal);
      line += `\x1b[${color}m${String.fromCharCode(brailleCode)}\x1b[0m`;
    }

    lines.push(line);
  }

  return lines;
}

// Heat map color scheme
function heatmapColor(normalized: number): string {
  if (normalized < 0.2) return '38;5;17';      // Dark blue
  if (normalized < 0.4) return '38;5;39';      // Cyan
  if (normalized < 0.6) return '38;5;226';     // Yellow
  if (normalized < 0.8) return '38;5;208';     // Orange
  return '38;5;196';                            // Red
}
```

**Zoom and Navigation:**
```typescript
interface CGRViewState {
  centerX: number;        // 0-1, center of view
  centerY: number;        // 0-1, center of view
  zoomLevel: number;      // 1 = full view, higher = zoomed in
  selectedKmer?: string;  // Highlighted k-mer
}

function getKmerAtPosition(x: number, y: number, k: number): string {
  // Reverse the CGR mapping to get the k-mer
  let kmer = '';
  for (let i = 0; i < k; i++) {
    // At each step, determine which quadrant we're in
    if (x < 0.5) {
      if (y < 0.5) { kmer = 'A' + kmer; }
      else { kmer = 'C' + kmer; }
    } else {
      if (y < 0.5) { kmer = 'T' + kmer; }
      else { kmer = 'G' + kmer; }
    }
    // Zoom into that quadrant
    x = (x < 0.5) ? x * 2 : (x - 0.5) * 2;
    y = (y < 0.5) ? y * 2 : (y - 0.5) * 2;
  }
  return kmer;
}
```

### Why This Is a Good Idea

1. **Complete K-mer Spectrum in One Image**: Unlike frequency tables that require choosing k, CGR captures ALL k-mer frequencies simultaneously. The k=3 frequencies are visible at coarse zoom; k=8 frequencies emerge when you zoom into specific regions. One visualization, infinite resolution.

2. **Instant Visual Phylogenetics**: Closely related phages have similar CGR patterns. You can visually cluster phages by their "fingerprints" without running alignment algorithms. AT-rich phages cluster together; GC-rich phages look different at a glance.

3. **Anomaly Detection**: Horizontally transferred regions have different k-mer compositions than the rest of the genome. These appear as texture discontinuities in the CGR — literally visible evidence of mosaic ancestry.

4. **Codon Bias Visualization**: For coding sequences, CGR reveals codon usage patterns. Highly expressed genes (with strong codon optimization) cluster in specific CGR regions, making expression level patterns visible.

5. **Algorithmic Elegance**: The algorithm is O(n) in sequence length, requiring only addition and division. No alignment, no comparison matrix, no dynamic programming. A 170kb phage genome renders in milliseconds.

### Innovation Assessment

**Novelty: 9/10 (Very High)**

CGR is a niche bioinformatics technique known mainly to theoretical biologists. It has been used in academic papers since the 1990s but almost never appears in user-facing tools. The combination of CGR with:
- Braille-character TUI rendering (8x resolution)
- Interactive zoom to explore k-mer space
- Real-time comparison between phage fingerprints
- Integration with genome browsing

...is unprecedented in any phage analysis platform.

### Pedagogical Value: 9/10

CGR teaches multiple deep concepts:
- **Iterated Function Systems (IFS)**: The CGR algorithm is an IFS, the same mathematics behind fractal image compression and procedural content generation
- **Bijective Mappings**: The 1:1 correspondence between k-mers and spatial positions is a beautiful example of encoding high-dimensional data in 2D
- **Information Theory**: Empty regions = forbidden k-mers = constraints on sequence space
- **Comparative Genomics**: Distance in CGR space correlates with phylogenetic distance
- **The Beauty of Chaos**: Deterministic iteration producing complex, unpredictable-looking patterns

### Cool/Wow Factor: 10/10

CGR produces genuinely beautiful, fractal images from DNA sequences. The "wow" moment when students realize that every point in the image corresponds to a specific genetic word, and the overall pattern is a unique signature of the organism, is profound. It makes the abstract concept of "genomic composition" tangible and visual.

### TUI Visualization

```
╭───────────────────────────────────────────────────────────────────────────╮
│  CHAOS GAME REPRESENTATION: Lambda Phage (48,502 bp)                      │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  A                                                               T        │
│   ┌─────────────────────────────────────────────────────────────────┐     │
│   │⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠠⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│     │
│   │⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⣾⣿⣿⣦⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣀⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│     │
│   │⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⣿⣿⣿⣿⣿⣿⣿⡄⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣾⣿⣿⣿⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│     │
│   │⠀⠀⠀⠀⠀⠀⠀⠀⣸⣿⣿⣿⣿⣿⣿⣿⣿⣿⡀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣴⣿⣿⣿⣿⣿⣿⣇⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│     │
│   │⠀⠀⣴⣶⣶⣄⠀⠀⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⣰⣶⣶⣄⠀⠀⠀⠀⠀⣶⣶⣦⡀⠀⢠⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⢀⣤⣶⣦⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│     │
│   │⠀⣸⣿⣿⣿⣿⣆⠀⢻⣿⣿⣿⣿⣿⣿⣿⣿⣿⠇⠀⣼⣿⣿⣿⣿⣧⠀⠀⠀⢸⣿⣿⣿⣿⡄⠘⣿⣿⣿⣿⣿⣿⣿⡟⠀⢠⣿⣿⣿⣿⣷⠀⠀⠀⠀⠀⠀⠀⠀⠀│     │
│   │⠀⣿⣿⣿⣿⣿⣿⡄⠈⢿⣿⣿⣿⣿⣿⣿⣿⠏⠀⣸⣿⣿⣿⣿⣿⣿⡆⠀⠀⣿⣿⣿⣿⣿⣿⡀⠹⣿⣿⣿⣿⣿⠟⠀⢀⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⠀⠀⠀⠀⠀│     │
│   │⠀⣿⣿⣿⣿⣿⣿⣿⠀⠀⠙⢿⣿⣿⣿⠟⠁⠀⢀⣿⣿⣿⣿⣿⣿⣿⣿⠀⢰⣿⣿⣿⣿⣿⣿⣧⠀⠈⠻⣿⠿⠋⠀⠀⣸⣿⣿⣿⣿⣿⣿⣷⠀⠀⠀⠀⠀⠀⠀⠀│     │
│   │⠀⢹⣿⣿⣿⣿⣿⣿⡆⠀⠀⠀⠀█ CG void █⢸⣿⣿⣿⣿⣿⣿⣿⣿⢸⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⢀⣿⣿⣿⣿⣿⣿⣿⣿⠀⠀⠀⠀⠀⠀⠀⠀│     │
│   │⠀⠈⢿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⣿⣿⣿⣿⣿⣿⣿⡟⢸⣿⣿⣿⣿⣿⣿⡿⠀⠀⠀⠀⠀⠀⠀⠸⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀│     │
│   │⠀⠀⠘⢿⣿⣿⣿⡿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢿⣿⣿⣿⣿⣿⣿⠃⠀⢻⣿⣿⣿⣿⡿⠁⠀⠀⠀⠀⠀⠀⠀⠀⠹⣿⣿⣿⣿⣿⡿⠀⠀⠀⠀⠀⠀⠀⠀⠀│     │
│   │⠀⠀⠀⠀⠙⠿⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠿⠿⠿⠟⠁⠀⠀⠀⠙⠿⠿⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⠿⠿⠋⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│     │
│   │                    (CpG suppression visible)                        │     │
│   └─────────────────────────────────────────────────────────────────────┘     │
│  C                                                               G        │
│                                                                           │
│  Statistics:                                                              │
│  ├─ Entropy: 7.84 bits (high complexity)                                  │
│  ├─ Empty cells: 12.3% (some k-mers absent)                               │
│  └─ CG depletion: 0.78 (mild CpG suppression)                             │
│                                                                           │
│  [+/-] Zoom  [←→↑↓] Pan  [C] Compare  [K] Show k-mer at cursor  [ESC] Exit│
╰───────────────────────────────────────────────────────────────────────────╯
```

**Side-by-Side Comparison View:**
```
╭─────────────────────────────────────────────────────────────────────────────╮
│  CGR COMPARISON: Lambda vs T4                                               │
├──────────────────────────────────┬──────────────────────────────────────────┤
│  Lambda Phage (48kb)             │  T4 Phage (169kb)                        │
│  ┌────────────────────────┐      │  ┌────────────────────────┐              │
│  │⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿│      │  │⣤⣤⣤⡤⡤⣤⣤⣤⣤⣤⣤⣤│              │
│  │⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿│      │  │⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤│              │
│  │⣿⣿⣿⣿░░░░⣿⣿⣿⣿│      │  │⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤│              │
│  │⣿⣿⣿⣿░░░░⣿⣿⣿⣿│      │  │⣤⣤⣤⣤⣿⣿⣿⣿⣤⣤⣤⣤│              │
│  │⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿│      │  │⣤⣤⣤⣤⣿⣿⣿⣿⣤⣤⣤⣤│              │
│  │⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿│      │  │⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤⣤│              │
│  └────────────────────────┘      │  └────────────────────────┘              │
│  GC: 49.8% | Entropy: 7.84      │  GC: 34.5% | Entropy: 7.62               │
├──────────────────────────────────┴──────────────────────────────────────────┤
│  Similarity: 67.3% (Pearson)  │  Note: T4 is AT-rich, pattern shifted      │
╰─────────────────────────────────────────────────────────────────────────────╯
```

---

## 23) Hilbert Curve Genome Atlas

### Concept

The Hilbert Curve Genome Atlas transforms a linear phage genome into a 2D spatial map using a **Hilbert space-filling curve** — a fractal curve that visits every point in a square while preserving locality. Unlike naive row-by-row wrapping, the Hilbert curve ensures that positions close in 1D remain close in 2D, making spatial patterns in the genome visible as coherent 2D regions rather than scattered lines.

**Why Hilbert curves are special:**
- **Locality preservation**: Unlike a raster scan (which has discontinuities at line ends), Hilbert curves maintain distance relationships. Nearby genes stay nearby
- **Fractal self-similarity**: The curve looks the same at every zoom level, enabling hierarchical exploration
- **Optimal compactness**: Among all space-filling curves, Hilbert has the best locality properties

**What the atlas reveals:**
- **Gene organization**: Early, middle, and late genes often cluster spatially on phage genomes. The Hilbert map shows these as distinct "provinces"
- **GC islands**: Regions with anomalous GC content (possibly acquired by HGT) appear as colored patches
- **Coding density**: Highly packed regions vs intergenic deserts become visually obvious
- **Temporal expression patterns**: Color by expression phase to see the genome's "timeline" in 2D
- **Structural features**: Promoter clusters, terminators, packaging signals form recognizable patterns

### Mathematical Foundations

**The Hilbert Curve Iteration:**
The Hilbert curve is defined recursively. A level-n curve fills a 2ⁿ × 2ⁿ grid:
```
Level 1 (2×2):     Level 2 (4×4):
┌──┐               ┌──┐  ┌──┐
│  │               │  │  │  │
└──┘               └──┘──└──┘
                   │        │
                   ┌──┐  ┌──┐
                   │  │  │  │
                   └──┘──└──┘
```

**Index-to-Coordinate Mapping:**
Given a 1D index d ∈ [0, 4ⁿ-1], compute (x, y) coordinates:
```
For each level s from 1 to n:
  1. Extract 2-bit quadrant from d
  2. Rotate/flip based on quadrant:
     - Quadrant 0: Swap x,y (↺ rotation)
     - Quadrant 1: No change
     - Quadrant 2: No change
     - Quadrant 3: Swap and flip (↻ rotation)
  3. Add quadrant offset to (x, y)
```

**Locality Metric:**
For a Hilbert curve, the maximum distance between adjacent points satisfies:
```
max|d(p₁,p₂) - 1| implies ||coord(p₁) - coord(p₂)||∞ ≤ √2 + 1
```
This is optimal among all space-filling curves.

**Coordinate-to-Index (Reverse Mapping):**
```
Given (x, y), compute 1D index:
  d = 0
  For s from 2^(n-1) down to 1:
    rx = (x & s) > 0 ? 1 : 0
    ry = (y & s) > 0 ? 1 : 0
    d += s² × ((3 × rx) ^ ry)
    Rotate/flip (x, y) based on (rx, ry)
```

**Multi-Scale Aggregation:**
For display at resolution 2ᵏ when genome has 4ⁿ positions (n > k):
```
Each pixel represents 4^(n-k) base pairs
Aggregate values (GC%, coding, etc.) by averaging over the range
```

### Implementation Approach

**Core Hilbert Engine:**
```typescript
interface HilbertConfig {
  order: number;            // Curve order (resolution = 2^order × 2^order)
  colorMode: 'gc' | 'coding' | 'phase' | 'complexity' | 'custom';
  windowSize: number;       // bp per calculation window
  smoothing: boolean;       // Apply Gaussian smoothing
}

interface HilbertResult {
  grid: Float32Array;       // Color values [0-1]
  resolution: number;       // 2^order
  metadata: {
    bpPerPixel: number;
    genomeLength: number;
    colorScale: { min: number; max: number };
  };
}

// Convert 1D index to 2D Hilbert coordinates
function hilbertD2XY(order: number, d: number): [number, number] {
  const n = 1 << order; // 2^order
  let x = 0, y = 0;
  let rx: number, ry: number, s: number, t = d;

  for (s = 1; s < n; s *= 2) {
    rx = 1 & Math.floor(t / 2);
    ry = 1 & (t ^ rx);

    // Rotate quadrant
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      // Swap x and y
      [x, y] = [y, x];
    }

    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }

  return [x, y];
}

// Convert 2D coordinates back to 1D index
function hilbertXY2D(order: number, x: number, y: number): number {
  const n = 1 << order;
  let d = 0;
  let rx: number, ry: number, s: number;

  for (s = n / 2; s > 0; s = Math.floor(s / 2)) {
    rx = (x & s) > 0 ? 1 : 0;
    ry = (y & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);

    // Rotate
    if (ry === 0) {
      if (rx === 1) {
        x = s - 1 - x;
        y = s - 1 - y;
      }
      [x, y] = [y, x];
    }
  }

  return d;
}

// Generate Hilbert genome atlas
function generateHilbertAtlas(
  sequence: string,
  genes: GeneInfo[],
  config: HilbertConfig
): HilbertResult {
  const resolution = 1 << config.order;
  const totalPixels = resolution * resolution;
  const grid = new Float32Array(totalPixels);

  const bpPerPixel = Math.ceil(sequence.length / totalPixels);

  // Pre-compute values for each pixel
  for (let d = 0; d < totalPixels; d++) {
    const [x, y] = hilbertD2XY(config.order, d);
    const startBp = d * bpPerPixel;
    const endBp = Math.min(startBp + bpPerPixel, sequence.length);

    if (startBp >= sequence.length) {
      grid[y * resolution + x] = -1; // Mark as empty
      continue;
    }

    const window = sequence.slice(startBp, endBp);
    let value: number;

    switch (config.colorMode) {
      case 'gc':
        value = calculateGC(window);
        break;
      case 'coding':
        value = calculateCodingDensity(startBp, endBp, genes);
        break;
      case 'phase':
        value = getExpressionPhase(startBp, endBp, genes);
        break;
      case 'complexity':
        value = kolmogorovComplexity(window);
        break;
      default:
        value = 0;
    }

    grid[y * resolution + x] = value;
  }

  // Find min/max for color scaling
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] >= 0) {
      if (grid[i] < min) min = grid[i];
      if (grid[i] > max) max = grid[i];
    }
  }

  // Normalize to [0, 1]
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] >= 0) {
      grid[i] = (grid[i] - min) / (max - min);
    }
  }

  return {
    grid,
    resolution,
    metadata: {
      bpPerPixel,
      genomeLength: sequence.length,
      colorScale: { min, max }
    }
  };
}

// Helper functions
function calculateGC(seq: string): number {
  let gc = 0;
  for (const c of seq.toUpperCase()) {
    if (c === 'G' || c === 'C') gc++;
  }
  return seq.length > 0 ? gc / seq.length : 0;
}

function calculateCodingDensity(
  start: number,
  end: number,
  genes: GeneInfo[]
): number {
  let codingBp = 0;
  for (const gene of genes) {
    const overlapStart = Math.max(start, gene.start);
    const overlapEnd = Math.min(end, gene.end);
    if (overlapStart < overlapEnd) {
      codingBp += overlapEnd - overlapStart;
    }
  }
  return codingBp / (end - start);
}
```

**Interactive Navigation:**
```typescript
interface HilbertViewState {
  zoomLevel: number;      // 1 = full, higher = zoomed
  centerX: number;        // Viewport center (0-1)
  centerY: number;
  hoveredBp: number;      // Current hover position in bp
  selectedGene?: string;  // Highlighted gene
}

// Click on map → get genomic position
function getGenomicPosition(
  x: number,
  y: number,
  order: number,
  genomeLength: number
): number {
  const d = hilbertXY2D(order, x, y);
  const resolution = 1 << order;
  const bpPerPixel = genomeLength / (resolution * resolution);
  return Math.floor(d * bpPerPixel);
}

// Sync with main sequence view
function syncWithSequenceView(bp: number): void {
  // Update main view scroll position to show this region
  store.setScrollPosition(bp);
}
```

**TUI Renderer with Block Characters:**
```typescript
// Use Unicode block elements for smooth gradients
const BLOCK_CHARS = [' ', '░', '▒', '▓', '█'];

function renderHilbertAtlas(
  atlas: HilbertResult,
  width: number,
  height: number,
  colorScheme: (value: number) => string
): string[] {
  const { grid, resolution } = atlas;
  const lines: string[] = [];

  // Scale grid to fit display
  const scaleX = resolution / width;
  const scaleY = resolution / height;

  for (let row = 0; row < height; row++) {
    let line = '';
    for (let col = 0; col < width; col++) {
      // Sample from grid (nearest neighbor or bilinear)
      const gridX = Math.floor(col * scaleX);
      const gridY = Math.floor(row * scaleY);
      const value = grid[gridY * resolution + gridX];

      if (value < 0) {
        line += ' '; // Empty (beyond genome)
      } else {
        const blockIdx = Math.min(
          Math.floor(value * BLOCK_CHARS.length),
          BLOCK_CHARS.length - 1
        );
        const color = colorScheme(value);
        line += `\x1b[${color}m${BLOCK_CHARS[blockIdx]}\x1b[0m`;
      }
    }
    lines.push(line);
  }

  return lines;
}

// Color schemes
const gcColorScheme = (v: number): string => {
  // Blue (low GC) → Green → Yellow → Red (high GC)
  if (v < 0.25) return '38;5;21';  // Blue
  if (v < 0.50) return '38;5;34';  // Green
  if (v < 0.75) return '38;5;226'; // Yellow
  return '38;5;196';                // Red
};

const phaseColorScheme = (v: number): string => {
  // Early (blue) → Middle (green) → Late (red)
  if (v < 0.33) return '38;5;39';  // Cyan (early)
  if (v < 0.66) return '38;5;46';  // Green (middle)
  return '38;5;202';                // Orange (late)
};
```

### Why This Is a Good Idea

1. **See the Whole Genome at Once**: Even T4's 170kb genome fits in a 128×128 grid (16kb per row in raster, but with preserved locality in Hilbert). Global organizational patterns become immediately visible that would require endless scrolling in linear view.

2. **Locality-Preserving Visualization**: Unlike simple line wrapping that creates artificial discontinuities, the Hilbert curve ensures that neighboring genomic regions remain visually adjacent. Gene clusters, operons, and regulatory regions form coherent 2D shapes.

3. **Multi-Layer Overlay System**: Color by GC content, coding density, expression timing, or complexity. Toggle between layers to see different aspects of genomic organization. The same spatial layout works for all metrics.

4. **Zoom-to-Sequence Integration**: Click any pixel to instantly navigate the main sequence view to that position. The atlas becomes a minimap for the entire exploration experience.

5. **Pattern Recognition**: Humans are excellent at recognizing 2D visual patterns. Converting 1D sequence data into 2D Hilbert space leverages this strength for rapid anomaly detection and structural understanding.

### Innovation Assessment

**Novelty: 9/10 (Very High)**

Hilbert curves are well-known in computer science and have been applied to genomics in research papers, but:
- Almost no user-facing tools expose this visualization
- TUI implementation with block characters is unprecedented
- Integration with genome browsing (click to navigate) is novel
- Multi-layer overlay system adds analytical power

The combination makes this a unique feature that will distinguish Phage Explorer from all competitors.

### Pedagogical Value: 8/10

Hilbert curves teach fundamental concepts:
- **Space-filling curves**: A beautiful mathematical concept with practical applications
- **Locality and dimensionality reduction**: How to preserve relationships when reducing dimensions
- **Genomic organization**: Why genes are arranged the way they are
- **Data visualization theory**: Why layout matters for pattern detection
- **Recursion and self-similarity**: The fractal nature of the curve at all scales

### Cool/Wow Factor: 9/10

The visual impact is dramatic — an entire genome compressed into a colored square that reveals hidden structure. The moment users realize they're seeing every base pair of a phage genome in a single image, and that clicking any pixel takes them there, is genuinely impressive. The Hilbert curve itself is aesthetically pleasing, with its continuous serpentine path.

### TUI Visualization

```
╭─────────────────────────────────────────────────────────────────────────────╮
│  HILBERT CURVE GENOME ATLAS: T4 Phage (168,903 bp)                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Color: GC Content (Blue < 30% | Green 40% | Yellow 50% | Red > 60%)        │
│                                                                             │
│   ┌─────────────────────────────────────────────────────────────────┐       │
│   │░░░░▒▒▒▒░░░░░░▒▒▒▒▓▓▓▓▒▒▒▒░░░░░░▒▒▒▒░░░░░░░░░░░░▒▒▒▒░░░░░░▒▒▒▒│       │
│   │░░▒▒▓▓▓▓▒▒░░░░▒▒▓▓████▓▓▒▒░░░░░░▒▒▓▓▒▒░░░░░░░░▒▒▓▓▒▒░░░░▒▒▓▓▒▒│       │
│   │░░▒▒▓▓▓▓▒▒░░  EARLY   ▓▓▒▒░░░░░░▒▒▓▓▓▓▒▒░░░░▒▒▓▓▓▓▒▒░░▒▒▓▓▓▓▒▒│       │
│   │░░░░▒▒▒▒░░░░  GENES   ▒▒░░░░░░░░░░▒▒▒▒░░░░░░░░▒▒▒▒░░░░░░▒▒▒▒░░│       │
│   │▒▒▒▒░░░░▒▒▒▒░░░░░░▒▒▒▒░░░░▒▒▒▒░░░░░░░░▓▓▓▓████▓▓▓▓░░░░░░░░░░░░│       │
│   │▓▓▓▓▒▒▒▒▓▓▓▓▒▒░░░░▒▒▓▓▒▒░░▓▓▓▓▒▒░░░░  MIDDLE  ████▒▒░░░░░░░░░░│       │
│   │▓▓▓▓▒▒▒▒▓▓▓▓▒▒░░░░▒▒▓▓▒▒░░▓▓▓▓▒▒░░░░  GENES   ████▒▒░░░░░░░░░░│       │
│   │▒▒▒▒░░░░▒▒▒▒░░░░░░░░▒▒░░░░▒▒▒▒░░░░░░░░▓▓▓▓████▓▓▓▓░░░░░░░░░░░░│       │
│   │░░░░░░░░░░░░░░░░▒▒▒▒▒▒▒▒▒▒▒▒░░░░░░░░░░░░░░▒▒▒▒░░░░████████████│       │
│   │░░░░░░░░░░░░░░▒▒▓▓▓▓▓▓▓▓▓▓▓▓▒▒░░░░░░░░░░▒▒▓▓▓▓▒▒░░  LATE     ░│       │
│   │░░░░░░░░░░░░▒▒▓▓████████████▓▓▒▒░░░░░░▒▒▓▓████▓▓▒▒  GENES    ░│       │
│   │░░░░░░░░░░░░▒▒▓▓████████████▓▓▒▒░░░░░░▒▒▓▓████▓▓▒▒████████████│       │
│   └─────────────────────────────────────────────────────────────────┘       │
│                                                                             │
│  Position: 84,451 bp  │  GC: 35.2%  │  Gene: gp32 (ssDNA binding)           │
│  Region: DNA replication / recombination cluster (Middle expression)       │
│                                                                             │
│  [↑↓←→] Navigate  [+/-] Zoom  [G/C/P/X] Color mode  [Enter] Jump  [ESC] Exit│
╰─────────────────────────────────────────────────────────────────────────────╯
```

**Multi-Genome Comparison:**
```
╭─────────────────────────────────────────────────────────────────────────────╮
│  HILBERT COMPARISON: Three Phage Genomes (GC Content)                       │
├─────────────────────┬─────────────────────┬─────────────────────────────────┤
│  Lambda (48kb)      │  T4 (169kb)         │  T7 (40kb)                      │
│  ┌───────────┐      │  ┌───────────┐      │  ┌───────────┐                  │
│  │▓▓▓▒▒░░▓▓▓│      │  │░░░░▒▒░░░░│      │  │▒▒▓▓▓▓▓▓▒▒│                  │
│  │▓▓████▓▓▓▓│      │  │░░▒▒▒▒▒▒░░│      │  │▓▓████████▓▓│                  │
│  │▒▒▓▓▓▓▒▒▒▒│      │  │░░▒▒░░▒▒░░│      │  │▓▓████████▓▓│                  │
│  │▒▒▓▓▓▓▒▒▒▒│      │  │░░░░░░░░░░│      │  │▒▒▓▓▓▓▓▓▒▒│                  │
│  └───────────┘      │  └───────────┘      │  └───────────┘                  │
│  GC: 49.8%         │  GC: 34.5%          │  GC: 48.4%                      │
├─────────────────────┴─────────────────────┴─────────────────────────────────┤
│  Note: T4's AT-richness creates distinct pattern; Lambda/T7 more similar    │
╰─────────────────────────────────────────────────────────────────────────────╯
```

---

## 24) Ribosome Traffic Jam Simulator

### Concept

The Ribosome Traffic Jam Simulator is a dynamic, real-time particle simulation that visualizes translation as ribosomes move along mRNA. Unlike static codon adaptation metrics, this simulation shows how rare codons create **kinetic bottlenecks** that affect protein production rates dynamically.

**The biological reality:**
- Ribosomes are ~20nm molecular machines that translate mRNA into protein
- Each ribosome occupies a "footprint" of ~10 codons (30 nucleotides)
- Translation speed varies by codon — common codons (abundant tRNAs) translate fast; rare codons stall
- When a ribosome stalls, following ribosomes pile up behind it, creating "traffic jams"
- These jams reduce protein output and can trigger quality control mechanisms

**Why dynamic simulation matters:**
- **CAI is a static average**: It tells you overall adaptation but not WHERE bottlenecks occur
- **Position matters**: A rare codon at position 50 might stall the first ribosome before more initiate
- **Jamming is nonlinear**: One slow codon doesn't slow production by 1% — the jam propagates
- **Initiation rate interaction**: High initiation + slow elongation = worse jams

**What the simulation reveals:**
- Exact positions of translation bottlenecks
- How jams propagate upstream
- Effect of codon choice on protein production rate
- Trade-offs in codon optimization strategies

### Mathematical Foundations

**TASEP Model (Totally Asymmetric Simple Exclusion Process):**
The canonical model for ribosome traffic. Particles (ribosomes) hop forward on a 1D lattice (codons) with:
```
- Entry rate: α (initiation)
- Hopping rate: p(c) = f(tRNA abundance for codon c)
- Exit rate: β (termination)
- Exclusion: No two ribosomes can occupy same site

Master equation:
∂ρᵢ/∂t = pᵢ₋₁ρᵢ₋₁(1-ρᵢ) - pᵢρᵢ(1-ρᵢ₊₁)

where ρᵢ = probability of site i being occupied
```

**Codon-Specific Elongation Rates:**
```
For each codon c:
  p(c) = w(c) / max(w)   where w(c) = tAI or RSCU weight

Typical values (E. coli):
  Fastest (AAA, Lys): p = 1.0 (25 codons/sec)
  Slowest (CGA, Arg): p = 0.05 (1.25 codons/sec)

Time to translate codon: τ(c) = 1/p(c) × τ_base
where τ_base ≈ 40ms for E. coli
```

**Ribosome Footprint and Exclusion:**
```
Footprint L ≈ 10 codons

Exclusion constraint:
  For ribosomes at positions xᵢ and xⱼ where i < j:
  xⱼ - xᵢ ≥ L

A ribosome can only advance if:
  next_position - nearest_upstream_ribosome ≥ L
```

**Steady-State Flux (Protein Production Rate):**
```
J = α × (1 - ρ₁)  [entry rate × probability first site free]

For uniform rates, mean-field theory gives:
  J = α(1-α)/(1+α)  if α < 0.5 (entry-limited)
  J = p(1-p)/(1+p)  if p < α (elongation-limited)

With non-uniform rates, bottleneck codon determines J.
```

**Queue Formation Dynamics:**
```
When a slow codon creates a jam:
  - Queue length grows until it hits initiation site
  - Then initiation is blocked (entry-limited regime)
  - Effective production rate = min(α, p_bottleneck)

Queue growth rate:
  dQ/dt = J_in - p_slow
  where J_in = rate of ribosomes arriving at slow site
```

### Implementation Approach

**Core Simulation Engine:**
```typescript
interface RibosomeState {
  id: number;
  position: number;           // Codon index
  waitTime: number;           // Ticks until next move
  state: 'translating' | 'waiting' | 'blocked';
  peptideLength: number;      // Amino acids synthesized
}

interface TranslationSimConfig {
  initiationRate: number;     // α: probability of new ribosome per tick
  terminationBonus: number;   // Speed multiplier for release
  footprintSize: number;      // Codons occupied by ribosome
  tickDuration: number;       // Milliseconds per simulation tick
  maxRibosomes: number;       // Limit for display
}

interface SimulationState {
  ribosomes: RibosomeState[];
  mRNA: string[];             // Array of codons
  elongationRates: number[];  // Rate for each codon position
  time: number;               // Simulation ticks elapsed
  producedProteins: number;   // Completed translations
  stallEvents: number;        // Times a ribosome was blocked
}

function initializeSimulation(
  sequence: string,
  codonWeights: Map<string, number>,
  config: TranslationSimConfig
): SimulationState {
  // Convert sequence to codon array
  const mRNA: string[] = [];
  for (let i = 0; i < sequence.length - 2; i += 3) {
    mRNA.push(sequence.slice(i, i + 3));
  }

  // Pre-compute elongation rates
  const maxWeight = Math.max(...codonWeights.values());
  const elongationRates = mRNA.map(codon => {
    const weight = codonWeights.get(codon) ?? 0.1;
    return weight / maxWeight; // Normalize to [0, 1]
  });

  return {
    ribosomes: [],
    mRNA,
    elongationRates,
    time: 0,
    producedProteins: 0,
    stallEvents: 0
  };
}

function simulationTick(
  state: SimulationState,
  config: TranslationSimConfig
): SimulationState {
  const newState = { ...state, time: state.time + 1 };

  // Try to initiate new ribosome
  if (Math.random() < config.initiationRate) {
    const firstRibosome = state.ribosomes.find(r =>
      r.position < config.footprintSize
    );
    if (!firstRibosome) {
      newState.ribosomes.push({
        id: state.time,
        position: 0,
        waitTime: 0,
        state: 'translating',
        peptideLength: 0
      });
    }
  }

  // Process each ribosome (from 3' to 5' to handle blocking)
  const sortedRibosomes = [...newState.ribosomes].sort(
    (a, b) => b.position - a.position
  );

  for (const ribosome of sortedRibosomes) {
    // Check if blocked by ribosome ahead
    const ahead = sortedRibosomes.find(r =>
      r.position > ribosome.position &&
      r.position - ribosome.position <= config.footprintSize
    );

    if (ahead) {
      ribosome.state = 'blocked';
      newState.stallEvents++;
      continue;
    }

    // Decrement wait time
    if (ribosome.waitTime > 0) {
      ribosome.waitTime--;
      ribosome.state = 'waiting';
      continue;
    }

    // Try to advance
    const nextPos = ribosome.position + 1;

    if (nextPos >= state.mRNA.length) {
      // Termination
      newState.producedProteins++;
      newState.ribosomes = newState.ribosomes.filter(
        r => r.id !== ribosome.id
      );
      continue;
    }

    // Move to next codon
    ribosome.position = nextPos;
    ribosome.peptideLength++;
    ribosome.state = 'translating';

    // Set wait time based on codon
    const rate = state.elongationRates[nextPos];
    // Geometric distribution: mean wait = 1/rate
    ribosome.waitTime = Math.floor(
      -Math.log(Math.random()) / rate
    );
  }

  return newState;
}

// Run simulation for N ticks and collect metrics
function runSimulation(
  sequence: string,
  codonWeights: Map<string, number>,
  config: TranslationSimConfig,
  ticks: number
): SimulationMetrics {
  let state = initializeSimulation(sequence, codonWeights, config);

  const occupancyHistory: number[][] = [];
  const productionHistory: number[] = [];

  for (let t = 0; t < ticks; t++) {
    state = simulationTick(state, config);

    // Record occupancy map
    const occupancy = new Array(state.mRNA.length).fill(0);
    for (const rib of state.ribosomes) {
      for (let i = 0; i < config.footprintSize; i++) {
        if (rib.position + i < occupancy.length) {
          occupancy[rib.position + i] = 1;
        }
      }
    }
    occupancyHistory.push(occupancy);
    productionHistory.push(state.producedProteins);
  }

  return {
    finalState: state,
    meanOccupancy: computeMeanOccupancy(occupancyHistory),
    productionRate: state.producedProteins / ticks,
    bottleneckPositions: findBottlenecks(occupancyHistory),
    stallRate: state.stallEvents / ticks
  };
}
```

**Real-Time Visualization:**
```typescript
interface RibosomeVisualState {
  position: number;
  color: string;
  char: string;
  blocked: boolean;
}

function renderTranslation(
  state: SimulationState,
  config: TranslationSimConfig,
  width: number
): string[] {
  const lines: string[] = [];
  const { mRNA, ribosomes, elongationRates } = state;

  // Visible window
  const startCodon = 0;
  const endCodon = Math.min(mRNA.length, width / 4);

  // Line 1: Codon labels (every 10th)
  let labelLine = '';
  for (let i = startCodon; i < endCodon; i++) {
    if (i % 10 === 0) {
      labelLine += i.toString().padStart(3) + ' ';
    } else {
      labelLine += '    ';
    }
  }
  lines.push(labelLine);

  // Line 2: mRNA codons
  let mrnaLine = '';
  for (let i = startCodon; i < endCodon; i++) {
    mrnaLine += `[${mRNA[i]}]`;
  }
  lines.push(`5'─${mrnaLine}─3'`);

  // Line 3: Ribosomes
  const ribosomeMap = new Map<number, RibosomeState>();
  for (const rib of ribosomes) {
    ribosomeMap.set(rib.position, rib);
  }

  let ribLine = '   ';
  for (let i = startCodon; i < endCodon; i++) {
    const rib = ribosomeMap.get(i);
    if (rib) {
      const char = rib.state === 'blocked' ? '⬤' :
                   rib.state === 'waiting' ? '◉' : '●';
      const color = rib.state === 'blocked' ? '\x1b[31m' : '\x1b[32m';
      ribLine += `${color}${char}\x1b[0m   `;
    } else {
      ribLine += '    ';
    }
  }
  lines.push(ribLine);

  // Line 4: Elongation rate heatmap
  let rateBar = 'Rate: ';
  for (let i = startCodon; i < endCodon; i++) {
    const rate = elongationRates[i];
    const char = rate > 0.8 ? '█' : rate > 0.5 ? '▓' : rate > 0.2 ? '▒' : '░';
    const color = rate > 0.5 ? '\x1b[32m' : rate > 0.2 ? '\x1b[33m' : '\x1b[31m';
    rateBar += `${color}${char}\x1b[0m`;
  }
  lines.push(rateBar);

  // Line 5: Traffic density
  let trafficLine = 'Jam:  ';
  const occupancy = computeOccupancy(ribosomes, mRNA.length, config.footprintSize);
  for (let i = startCodon; i < endCodon; i++) {
    if (occupancy[i]) {
      trafficLine += '█';
    } else {
      trafficLine += ' ';
    }
  }
  lines.push(trafficLine);

  return lines;
}

function computeOccupancy(
  ribosomes: RibosomeState[],
  length: number,
  footprint: number
): boolean[] {
  const occupied = new Array(length).fill(false);
  for (const rib of ribosomes) {
    for (let i = 0; i < footprint; i++) {
      if (rib.position + i < length) {
        occupied[rib.position + i] = true;
      }
    }
  }
  return occupied;
}
```

### Why This Is a Good Idea

1. **Dynamic vs Static Understanding**: CAI and tAI give static averages. This simulation shows the actual kinetic behavior — where jams form, how they propagate, and how they resolve. Students see that codon optimization is about traffic flow, not just individual codon quality.

2. **Visualizes Emergent Phenomena**: Traffic jams are emergent — they arise from simple local rules but have global effects. Watching ribosomes pile up behind a single slow codon creates intuition that no static metric can provide.

3. **Interactive Exploration**: Users can modify initiation rates, watch different genes, compare wild-type vs optimized sequences, and see immediate effects. This kind of "what-if" exploration is impossible with static analyses.

4. **Connects to Real Experiments**: The simulation parallifies ribosome profiling experiments. Users learn why those experiments show "ribosome footprint pileups" at certain codons.

5. **Engaging and Memorable**: There's something mesmerizing about watching particles move along a track and pile up. It's a "lava lamp" for molecular biology that makes learning enjoyable.

### Innovation Assessment

**Novelty: 10/10 (Extremely High)**

Dynamic translation simulations exist in research software (SimPool, TASEP models), but:
- No general-purpose phage/genome browser includes one
- TUI-based real-time visualization is unprecedented
- Integration with actual phage sequences is novel
- Interactive parameter adjustment is unique

This feature would be genuinely unique in the field.

### Pedagogical Value: 10/10

This is perhaps the most pedagogically valuable feature in the entire roadmap:
- **TASEP models**: Fundamental physics of exclusion processes
- **Translation kinetics**: How protein production actually works
- **Codon optimization**: Why and how to optimize genes for expression
- **Systems biology**: Emergent behavior from simple rules
- **Ribosome profiling**: Connects to modern experimental techniques

### Cool/Wow Factor: 10/10

Watching ribosomes collide and create traffic jams in real-time is genuinely captivating. The "aha" moment when a student sees a rare codon create a pileup that propagates back to the start codon is powerful. This feature turns abstract kinetics into a game-like experience.

### TUI Visualization

```
╭─────────────────────────────────────────────────────────────────────────────╮
│  RIBOSOME TRAFFIC SIMULATOR: Lambda cI gene (repressor)                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Time: 00:42.3  │  Proteins: 7  │  Active Ribosomes: 4  │  Stalls: 23      │
│                                                                             │
│    0         10        20        30        40        50        60          │
│  5'─[AUG][GCA][AAA][GAA][CGA][UUU][GGU][AAA][CGA][GAC][AAA][UGA]─3'         │
│     ●➔       ●➔                 ◉(wait)        ⬤(JAM!)   ●➔                │
│                                                                             │
│  Rate: ████████░░████████░░████████░░████████▒▒████████████                 │
│        Fast─────────────────Slow────────────────Fast                        │
│                                                                             │
│  Traffic Density:                                                           │
│  ╭────────────────────────────────────────────────────────────────────────╮ │
│  │░░░░░░░░░░░░░░░░░░████████████████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░│ │
│  │         ↑ Bottleneck at codon 32 (CGA - rare Arg)                     │ │
│  ╰────────────────────────────────────────────────────────────────────────╯ │
│                                                                             │
│  Metrics:                                                                   │
│  ├─ Production rate: 0.17 proteins/sec (suboptimal)                         │
│  ├─ Theoretical max: 0.42 proteins/sec                                      │
│  ├─ Bottleneck cost: 59% efficiency loss                                    │
│  └─ Suggested fix: CGA→CGU at position 32                                   │
│                                                                             │
│  [Space] Pause  [←→] Speed  [R] Reset  [O] Optimize  [C] Compare  [ESC] Exit│
╰─────────────────────────────────────────────────────────────────────────────╯
```

**Comparison View (Wild-Type vs Optimized):**
```
╭─────────────────────────────────────────────────────────────────────────────╮
│  TRANSLATION COMPARISON: Wild-Type vs Codon-Optimized                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  WILD-TYPE (original sequence):                                             │
│  5'─[AUG][GCA][CGA][GAA][CGA][UUU][AGG][AAA][CGA][GAC]─3'                   │
│     ●➔   ●➔   ⬤⬤⬤⬤⬤⬤⬤⬤⬤⬤ (massive jam at CGA cluster!)                  │
│  Rate: ████░░████░░████░░████░░████████                                     │
│  Production: 0.08 proteins/sec                                              │
│                                                                             │
│  OPTIMIZED (synonymous substitutions):                                      │
│  5'─[AUG][GCA][CGU][GAA][CGU][UUU][CGU][AAA][CGU][GAC]─3'                   │
│     ●➔   ●➔   ●➔   ●➔   ●➔   (smooth flow!)                               │
│  Rate: ████████████████████████████████                                     │
│  Production: 0.38 proteins/sec (+375%)                                      │
│                                                                             │
│  Summary: Replaced 4 CGA→CGU codons. Same amino acid, 4.7x more protein.    │
│                                                                             │
╰─────────────────────────────────────────────────────────────────────────────╯
```

---

## 25) Intrinsic DNA Curvature & Stiffness Map

### Concept

DNA is not the straight, rigid rod that textbooks often depict. It's a flexible polymer with sequence-dependent mechanical properties. Certain sequences, particularly **A-tracts** (runs of 4-6 adenines), cause the helix axis to bend, while **GC-rich regions** tend to be stiffer. This intrinsic curvature and flexibility have profound biological consequences:

**Why DNA curvature matters for phages:**
- **Capsid packaging**: Phage DNA must bend extremely tightly to fit inside the capsid (radius ~30nm for a 50kb genome). Sequence-encoded flexibility can facilitate this, while stiff regions may resist
- **Packaging signals (pac/cos sites)**: These recognition sequences often have unusual structural features that the terminase complex recognizes
- **Promoter architecture**: DNA must wrap around RNA polymerase; curved promoters can pre-position DNA optimally
- **Recombination hotspots**: Bent DNA exposes the minor groove, facilitating protein binding

**The physical basis:**
- Each dinucleotide step has characteristic **roll**, **tilt**, and **twist** angles
- A-tracts compress the minor groove and cause the helix to curve toward it
- The cumulative effect of many small bends creates large-scale curvature
- **Persistence length** (~150bp for random DNA) describes stiffness

### Mathematical Foundations

**Dinucleotide Wedge Model:**
Each of the 16 dinucleotides has characteristic structural parameters:
```
Step parameters (from crystallography):
  Roll (ρ): Rotation around the long axis of base pair
  Tilt (τ): Rotation around short axis
  Twist (Ω): Rotation around helix axis

For dinucleotide XY:
  ρ_XY, τ_XY, Ω_XY are tabulated values (degrees)

Popular datasets:
  - Bolshoy et al. (1991): Averaged from gel mobility experiments
  - Olson et al. (1998): From crystal structures
  - Dixit et al. (2005): From MD simulations
```

**Curvature Calculation:**
The helix axis trajectory is computed by accumulating rotation matrices:
```
For each position i along the sequence:
  R_i = R_x(tilt_i) × R_y(roll_i) × R_z(twist_i)

Helix axis direction at position i:
  d_i = R_1 × R_2 × ... × R_i × [0, 0, 1]ᵀ

Local curvature κ over window W:
  κ = |Δd| / (L × W)  where L = 0.34 nm/bp rise
  Δd = d_{i+W} - d_{i-W}

Expressed in degrees per helical turn (10.5 bp):
  κ_deg = κ × 10.5 × (180/π)
```

**A-Tract Curvature Rule:**
A-tracts bend DNA toward the minor groove. Empirical formula:
```
For n consecutive A:T pairs (A-tract of length n ≥ 4):
  Bend angle ≈ 17° + 4° × (n - 4)  (maximum ~35°)

A-tracts phased by ~10.5 bp add constructively:
  Total curvature = N × individual_bend × cos(Δphase)
```

**Bendability/Stiffness:**
Flexibility varies by dinucleotide. The **persistence length** P relates to stiffness:
```
Persistence length formula:
  P = k_B T / (bend_stiffness)

Relative flexibility (from DNase I cleavage):
  AA/TT: 1.0 (reference)
  TA: 1.5 (very flexible)
  CG: 0.6 (stiff)
  GC: 0.7 (stiff)

Local persistence length from sequence:
  P_local = Σ w_i × P_dinucleotide_i
```

### Implementation Approach

**Dinucleotide Parameter Tables:**
```typescript
// Bolshoy wedge angles (degrees)
const WEDGE_ANGLES: Record<string, { roll: number; tilt: number; twist: number }> = {
  'AA': { roll: -6.5, tilt: 0.9, twist: 35.1 },
  'AT': { roll: -5.4, tilt: 0.0, twist: 29.3 },
  'AC': { roll: -7.8, tilt: 1.6, twist: 31.5 },
  'AG': { roll: -4.4, tilt: 1.3, twist: 31.9 },
  'TA': { roll:  2.0, tilt: 0.0, twist: 36.3 },
  'TT': { roll: -6.5, tilt: -0.9, twist: 35.1 },
  'TC': { roll: -3.6, tilt: 0.5, twist: 33.0 },
  'TG': { roll: -2.0, tilt: 2.0, twist: 35.0 },
  'CA': { roll: -2.0, tilt: -2.0, twist: 35.0 },
  'CT': { roll: -4.4, tilt: -1.3, twist: 31.9 },
  'CC': { roll: -3.7, tilt: 0.0, twist: 33.3 },
  'CG': { roll:  3.7, tilt: 0.0, twist: 29.8 },
  'GA': { roll: -3.6, tilt: -0.5, twist: 33.0 },
  'GT': { roll: -7.8, tilt: -1.6, twist: 31.5 },
  'GC': { roll: -1.3, tilt: 0.0, twist: 33.6 },
  'GG': { roll: -3.7, tilt: 0.0, twist: 33.3 },
};

// Flexibility scores (higher = more bendable)
const FLEXIBILITY: Record<string, number> = {
  'AA': 1.0, 'AT': 1.2, 'AC': 0.9, 'AG': 1.0,
  'TA': 1.5, 'TT': 1.0, 'TC': 0.9, 'TG': 1.1,
  'CA': 1.1, 'CT': 1.0, 'CC': 0.8, 'CG': 0.6,
  'GA': 0.9, 'GT': 0.9, 'GC': 0.7, 'GG': 0.8,
};

interface CurvatureResult {
  curvature: Float32Array;     // Degrees per helical turn
  flexibility: Float32Array;   // Relative bendability
  aTractPositions: number[];   // Start positions of A-tracts
  peakCurvature: number;       // Maximum curvature
  meanFlexibility: number;     // Overall flexibility score
}

function analyzeCurvature(
  sequence: string,
  windowSize: number = 21  // ~2 helical turns
): CurvatureResult {
  const n = sequence.length;
  const curvature = new Float32Array(n);
  const flexibility = new Float32Array(n);
  const aTractPositions: number[] = [];

  // Find A-tracts
  const aTractRegex = /A{4,}|T{4,}/gi;
  let match;
  while ((match = aTractRegex.exec(sequence)) !== null) {
    aTractPositions.push(match.index);
  }

  // Calculate per-position curvature using sliding window
  const halfWindow = Math.floor(windowSize / 2);

  for (let i = halfWindow; i < n - halfWindow - 1; i++) {
    // Accumulate roll/tilt vectors in window
    let rollSum = 0;
    let tiltSum = 0;
    let flexSum = 0;

    for (let j = i - halfWindow; j < i + halfWindow; j++) {
      const dinuc = sequence.slice(j, j + 2).toUpperCase();
      const angles = WEDGE_ANGLES[dinuc];
      const flex = FLEXIBILITY[dinuc];

      if (angles) {
        // Phase-dependent addition (account for helix repeat)
        const phase = ((j - i) * 2 * Math.PI) / 10.5;
        rollSum += angles.roll * Math.cos(phase);
        tiltSum += angles.tilt * Math.sin(phase);
      }
      if (flex) {
        flexSum += flex;
      }
    }

    // Total curvature magnitude (degrees per helical turn)
    curvature[i] = Math.sqrt(rollSum * rollSum + tiltSum * tiltSum) / windowSize * 10.5;
    flexibility[i] = flexSum / windowSize;
  }

  // Statistics
  let peakCurvature = 0;
  let totalFlex = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    if (curvature[i] > peakCurvature) peakCurvature = curvature[i];
    if (flexibility[i] > 0) {
      totalFlex += flexibility[i];
      count++;
    }
  }

  return {
    curvature,
    flexibility,
    aTractPositions,
    peakCurvature,
    meanFlexibility: count > 0 ? totalFlex / count : 1.0
  };
}
```

**3D Helix Trajectory Visualization:**
```typescript
interface HelixPoint {
  x: number;
  y: number;
  z: number;
  bp: number;
}

function computeHelixTrajectory(
  sequence: string,
  stepSize: number = 10  // Compute every N bp
): HelixPoint[] {
  const points: HelixPoint[] = [];

  // Accumulate rotation matrix
  let x = 0, y = 0, z = 0;
  let dx = 0, dy = 0, dz = 1;  // Initial direction: along Z

  const rise = 0.34;  // nm per bp

  for (let i = 0; i < sequence.length - 1; i++) {
    const dinuc = sequence.slice(i, i + 2).toUpperCase();
    const angles = WEDGE_ANGLES[dinuc] ?? { roll: 0, tilt: 0, twist: 34 };

    // Convert to radians
    const roll = angles.roll * Math.PI / 180;
    const tilt = angles.tilt * Math.PI / 180;
    const twist = angles.twist * Math.PI / 180;

    // Apply rotations to direction vector
    // (Simplified - full implementation uses rotation matrices)
    const newDx = dx * Math.cos(twist) - dy * Math.sin(twist);
    const newDy = dx * Math.sin(twist) + dy * Math.cos(twist);
    dx = newDx + roll * dz;
    dy = newDy + tilt * dz;

    // Normalize
    const mag = Math.sqrt(dx*dx + dy*dy + dz*dz);
    dx /= mag; dy /= mag; dz /= mag;

    // Advance position
    x += dx * rise;
    y += dy * rise;
    z += dz * rise;

    if (i % stepSize === 0) {
      points.push({ x, y, z, bp: i });
    }
  }

  return points;
}

// Project 3D trajectory to 2D for ASCII visualization
function projectTrajectory(
  points: HelixPoint[],
  width: number,
  height: number
): string[] {
  // Find bounding box
  const xs = points.map(p => p.x);
  const ys = points.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);

  const grid: string[][] = Array(height).fill(0)
    .map(() => Array(width).fill(' '));

  for (const point of points) {
    const px = Math.floor(((point.x - minX) / (maxX - minX)) * (width - 1));
    const py = Math.floor(((point.y - minY) / (maxY - minY)) * (height - 1));
    grid[py][px] = '●';
  }

  return grid.map(row => row.join(''));
}
```

### Why This Is a Good Idea

1. **Reveals Hidden Physics**: DNA sequences encode not just information but physical properties. Curvature maps make this invisible layer visible, helping users understand why certain sequences function as packaging signals or promoters.

2. **Explains Experimental Observations**: Gel mobility anomalies, DNase I footprinting patterns, and atomic force microscopy images all relate to DNA curvature. This feature connects sequence to these experimental readouts.

3. **Capsid Packaging Insights**: Phage DNA packaging is a remarkable feat of molecular engineering. Showing which regions are flexible (easy to pack) vs stiff (resistant) provides intuition for how terminases and capsid proteins work.

4. **Unique Analytical Perspective**: While many tools calculate GC content or find genes, almost none show structural predictions. This adds an entirely new dimension to genome analysis.

5. **Beautiful Visualizations**: The 3D helix trajectory and curvature sparklines create visually striking displays that make the abstract concept of DNA shape tangible.

### Innovation Assessment

**Novelty: 8/10 (High)**

DNA curvature prediction has existed since the 1980s but remains confined to specialized structural biology software. Integrating it into a genome browser, especially with:
- Interactive visualization in a TUI
- Overlay on gene maps
- Connection to packaging biology

...is highly innovative.

### Pedagogical Value: 9/10

This feature teaches concepts rarely encountered in standard bioinformatics:
- **Polymer physics**: Persistence length, bending energy
- **DNA structure**: Beyond the B-form double helix
- **Sequence-structure relationships**: How sequence determines shape
- **Biological function of structure**: Why DNA shape matters
- **Crystallographic parameters**: Roll, tilt, twist

### Cool/Wow Factor: 8/10

Seeing DNA as a curved, flexible molecule rather than a straight line is eye-opening. The 3D trajectory visualization, showing how the helix axis snakes through space, provides a new way of thinking about genomes that most users have never encountered.

### TUI Visualization

```
╭─────────────────────────────────────────────────────────────────────────────╮
│  DNA CURVATURE & FLEXIBILITY: Lambda cos site region (47,000-49,000 bp)     │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Curvature (°/turn):  [Straight] ▁▂▃▄▅▆▇█ [Bent]                           │
│  ════════════════════════════════════════════════════════════════════════   │
│                                                                             │
│       47000      47200      47400      47600      47800      48000          │
│  ────────────────────────────────────────────────────────────────────────   │
│       ▂▂▃▃▂▂▁▁▂▃▅▇███▇▅▃▂▁▁▂▂▃▃▂▂▁▁▂▃▅▆▇██▇▆▅▃▂▁▁▂▂▃▃▂▂▁▁▂▃▄▅   │
│                   ↑↑↑ A-tract cluster       ↑↑ Strong bend                  │
│                   cos site recognition      Packaging kink                  │
│                                                                             │
│  Flexibility:     [Stiff] ░▒▓█ [Flexible]                                   │
│  ────────────────────────────────────────────────────────────────────────   │
│       ▓▓▓▒▒░░░░▒▒▓▓██▓▓▒▒░░▒▒▓▓▓▓▒▒░░░░▒▒▓▓██████▓▓▒▒░░░░▒▒▓▓              │
│                                         ↑↑↑ TA-rich = flexible              │
│                                                                             │
│  A-tracts:        ●           ●                    ●●                       │
│                   AAAAA       AAAA                 AAAAAA                   │
│                                                                             │
│  Helix Trajectory (top view):                                               │
│  ┌────────────────────────────────────────────────────────────────┐         │
│  │            ●●●                                                  │         │
│  │         ●●●   ●●●                    ●●●●●                      │         │
│  │       ●●         ●●              ●●●●     ●●●●                  │         │
│  │      ●             ●           ●●             ●●●               │         │
│  │     ●              ●●        ●●                 ●●              │         │
│  │   ●●                 ●●    ●●                    ●●●            │         │
│  │  ●                     ●●●●                        ●●           │         │
│  └────────────────────────────────────────────────────────────────┘         │
│  DNA bends significantly at A-tracts, creating recognition features         │
│                                                                             │
│  Statistics:                                                                │
│  ├─ Peak curvature: 34.2°/turn at position 47,412 (A-tract)                 │
│  ├─ Mean flexibility: 1.12 (slightly above average)                         │
│  └─ A-tracts found: 8 (3 in phased arrangement)                             │
│                                                                             │
│  [←→] Scroll  [+/-] Window size  [F] Toggle flexibility  [3] 3D view  [ESC] │
╰─────────────────────────────────────────────────────────────────────────────╯
```

---

## 26) Virtual Agarose Gel Electrophoresis

### Concept

The Virtual Agarose Gel Electrophoresis simulator brings a classic molecular biology technique to the terminal. Users select restriction enzymes, "digest" phage genomes in silico, and visualize the resulting DNA fragments as bands on a virtual gel — complete with a size ladder, realistic band intensities, and the characteristic log-linear migration pattern.

**Why this matters for phage research:**
- **Experimental planning**: Before spending time and reagents, predict what your gel will look like
- **Strain verification**: Restriction patterns are "fingerprints" for phage identity
- **Genetic mapping**: Historical technique still useful for quick localization
- **Cloning design**: Identify suitable restriction sites for inserting/extracting genes
- **Teaching tool**: Visualize the relationship between sequence and physical fragments

**The physics of gel electrophoresis:**
- DNA is negatively charged (phosphate backbone) and migrates toward the positive electrode
- Agarose gel acts as a molecular sieve — small fragments move faster through the pores
- Migration distance is approximately linear with log(fragment size)
- Band intensity reflects the mass of DNA, not the number of molecules

### Mathematical Foundations

**Restriction Site Finding:**
```
For restriction enzyme E with recognition sequence R:
  - Find all positions where sequence matches R
  - Handle palindromic sequences (most enzymes)
  - Account for degenerate bases (N, Y, R, W, S, K, M)
  - Apply cut offset (e.g., EcoRI cuts after G: G↓AATTC)

Common enzymes:
  EcoRI:    G↓AATTC      (6-cutter, cuts every ~4096 bp on average)
  HindIII:  A↓AGCTT      (6-cutter)
  BamHI:    G↓GATCC      (6-cutter)
  NotI:     GC↓GGCCGC    (8-cutter, rare, ~65536 bp average)
  HaeIII:   GG↓CC        (4-cutter, frequent, ~256 bp average)
```

**Fragment Generation:**
```
Given cut positions [p₁, p₂, ..., pₙ] sorted:
  Fragment lengths = [p₁ - 0, p₂ - p₁, p₃ - p₂, ..., L - pₙ]
  where L = genome length

For circular genomes:
  Last fragment connects pₙ to p₁: (L - pₙ) + p₁

For double digest (enzymes A and B):
  Merge cut sites, sort, generate fragments
```

**Migration Distance (Ogston Model):**
```
For fragment of length L bp in gel of concentration C%:

Log-linear relationship:
  log₁₀(L) = a - b × d

where:
  d = migration distance
  a, b = constants depending on gel concentration

Inverted for rendering:
  d = (a - log₁₀(L)) / b

Typical values (1% agarose):
  a ≈ 4.5, b ≈ 0.05  (calibrate from ladder)

Resolution limits:
  - Fragments < 200bp: poor resolution in standard gels
  - Fragments > 20kb: compress at top, need PFGE
```

**Band Intensity:**
```
Intensity proportional to mass (amount of DNA × length):
  I ∝ (fragment_copies × fragment_length)

For single genome digest:
  All fragments have equal copy number (1 per genome)
  I ∝ fragment_length

Visualization: band width or brightness scales with length
  (longer fragments appear brighter/wider)
```

**Expected Fragment Count:**
```
For random sequence of length L with enzyme cutting every k bp on average:
  Expected cuts = L / k
  Expected fragments = L / k + 1 (linear) or L / k (circular)

For 6-cutter: k ≈ 4⁶ = 4096 bp
  Lambda (48.5kb): ~12 fragments expected
  T4 (169kb): ~41 fragments expected
```

### Implementation Approach

**Restriction Enzyme Database:**
```typescript
interface RestrictionEnzyme {
  name: string;
  recognitionSite: string;  // IUPAC with cut marker
  cutOffset: number;        // Position of cut (5' to 3')
  overhang: '5' | '3' | 'blunt';
  frequency: number;        // Expected cuts per 4^n bp
}

const ENZYMES: Record<string, RestrictionEnzyme> = {
  'EcoRI': {
    name: 'EcoRI',
    recognitionSite: 'GAATTC',
    cutOffset: 1,
    overhang: '5',
    frequency: 4096
  },
  'HindIII': {
    name: 'HindIII',
    recognitionSite: 'AAGCTT',
    cutOffset: 1,
    overhang: '5',
    frequency: 4096
  },
  'BamHI': {
    name: 'BamHI',
    recognitionSite: 'GGATCC',
    cutOffset: 1,
    overhang: '5',
    frequency: 4096
  },
  'NotI': {
    name: 'NotI',
    recognitionSite: 'GCGGCCGC',
    cutOffset: 2,
    overhang: '5',
    frequency: 65536
  },
  'HaeIII': {
    name: 'HaeIII',
    recognitionSite: 'GGCC',
    cutOffset: 2,
    overhang: 'blunt',
    frequency: 256
  },
  // ... more enzymes
};

// Handle degenerate bases
const IUPAC: Record<string, string> = {
  'N': '[ACGT]', 'R': '[AG]', 'Y': '[CT]',
  'W': '[AT]', 'S': '[CG]', 'K': '[GT]',
  'M': '[AC]', 'B': '[CGT]', 'D': '[AGT]',
  'H': '[ACT]', 'V': '[ACG]'
};

function siteToRegex(site: string): RegExp {
  let pattern = '';
  for (const char of site.toUpperCase()) {
    pattern += IUPAC[char] || char;
  }
  return new RegExp(pattern, 'gi');
}
```

**Digestion Engine:**
```typescript
interface DigestResult {
  enzyme: string;
  cutSites: number[];      // Positions of cuts
  fragments: Fragment[];    // Resulting fragments
  mapData: string;          // Text representation of cut map
}

interface Fragment {
  start: number;
  end: number;
  length: number;
  index: number;            // Fragment number
}

function digestGenome(
  sequence: string,
  enzymeName: string,
  circular: boolean = false
): DigestResult {
  const enzyme = ENZYMES[enzymeName];
  if (!enzyme) throw new Error(`Unknown enzyme: ${enzymeName}`);

  const regex = siteToRegex(enzyme.recognitionSite);
  const cutSites: number[] = [];

  let match;
  while ((match = regex.exec(sequence)) !== null) {
    cutSites.push(match.index + enzyme.cutOffset);
  }

  cutSites.sort((a, b) => a - b);

  // Generate fragments
  const fragments: Fragment[] = [];
  const len = sequence.length;

  if (cutSites.length === 0) {
    // No cuts - entire genome is one fragment
    fragments.push({ start: 0, end: len, length: len, index: 1 });
  } else {
    // First fragment
    if (!circular) {
      fragments.push({
        start: 0,
        end: cutSites[0],
        length: cutSites[0],
        index: 1
      });
    }

    // Middle fragments
    for (let i = 0; i < cutSites.length - 1; i++) {
      fragments.push({
        start: cutSites[i],
        end: cutSites[i + 1],
        length: cutSites[i + 1] - cutSites[i],
        index: i + 2
      });
    }

    // Last fragment
    const lastCut = cutSites[cutSites.length - 1];
    if (circular) {
      // Connects back to first cut
      fragments.push({
        start: lastCut,
        end: cutSites[0] + len,
        length: (len - lastCut) + cutSites[0],
        index: cutSites.length
      });
    } else {
      fragments.push({
        start: lastCut,
        end: len,
        length: len - lastCut,
        index: cutSites.length + 1
      });
    }
  }

  // Sort by length for easy comparison
  fragments.sort((a, b) => b.length - a.length);

  return {
    enzyme: enzymeName,
    cutSites,
    fragments,
    mapData: generateCutMap(sequence.length, cutSites, enzymeName)
  };
}

function generateCutMap(
  length: number,
  cutSites: number[],
  enzyme: string
): string {
  // Generate a text-based map of cut sites
  const scale = 60; // characters
  let map = '';

  // Scale bar
  const tick = Math.round(length / 10);
  for (let i = 0; i <= 10; i++) {
    map += (i * tick / 1000).toFixed(0).padStart(5) + 'kb';
  }
  map += '\n';

  // Line with cut marks
  let line = '─'.repeat(scale);
  for (const site of cutSites) {
    const pos = Math.floor((site / length) * scale);
    line = line.slice(0, pos) + '│' + line.slice(pos + 1);
  }
  map += `[${line}]\n`;
  map += `${cutSites.length} ${enzyme} cut sites`;

  return map;
}
```

**Gel Renderer:**
```typescript
interface GelConfig {
  width: number;          // Characters per lane
  height: number;         // Gel height in lines
  lanes: GelLane[];       // Samples to load
  ladder: number[];       // Size standards (bp)
  concentration: number;  // Agarose % (affects resolution)
}

interface GelLane {
  name: string;
  fragments: number[];    // Fragment sizes in bp
}

function renderGel(config: GelConfig): string[] {
  const { width, height, lanes, ladder, concentration } = config;
  const lines: string[] = [];

  // Calculate migration parameters from ladder
  const minSize = Math.min(...ladder);
  const maxSize = Math.max(...ladder);
  const logMin = Math.log10(minSize);
  const logMax = Math.log10(maxSize);

  // Map log(size) to position
  const sizeToRow = (size: number): number => {
    const logSize = Math.log10(Math.max(size, minSize));
    const normalized = (logMax - logSize) / (logMax - logMin);
    return Math.floor(normalized * (height - 2)) + 1;
  };

  // Initialize gel grid
  const totalWidth = (lanes.length + 1) * (width + 2) + 1;
  const gel: string[][] = Array(height).fill(0)
    .map(() => Array(totalWidth).fill(' '));

  // Add wells at top
  let x = 1;
  gel[0][x] = '▼'; // Ladder well
  x += width + 2;
  for (const lane of lanes) {
    gel[0][x] = '▼';
    x += width + 2;
  }

  // Draw ladder bands
  x = 1;
  for (const size of ladder) {
    const row = sizeToRow(size);
    for (let dx = 0; dx < width; dx++) {
      gel[row][x + dx] = '━';
    }
  }
  x += width + 2;

  // Draw sample bands
  for (const lane of lanes) {
    for (const size of lane.fragments) {
      if (size < minSize * 0.8 || size > maxSize * 1.2) continue;
      const row = sizeToRow(size);

      // Band width proportional to log(size) for intensity
      const intensity = Math.min(width, Math.max(2,
        Math.floor(Math.log10(size) * 2)
      ));
      const offset = Math.floor((width - intensity) / 2);

      for (let dx = offset; dx < offset + intensity; dx++) {
        gel[row][x + dx] = '█';
      }
    }
    x += width + 2;
  }

  // Add lane labels
  const labelLine = Array(totalWidth).fill(' ');
  x = 1 + Math.floor(width / 2) - 3;
  'Ladder'.split('').forEach((c, i) => labelLine[x + i] = c);
  x = 1 + width + 2;
  for (const lane of lanes) {
    const label = lane.name.slice(0, width);
    const offset = Math.floor((width - label.length) / 2);
    label.split('').forEach((c, i) => labelLine[x + offset + i] = c);
    x += width + 2;
  }

  // Add size markers
  const markerX = 0;
  for (const size of ladder) {
    const row = sizeToRow(size);
    const label = size >= 1000 ? `${size/1000}kb` : `${size}`;
    // Place label to the left (we'd need more space in real impl)
  }

  // Convert to strings
  for (let row = 0; row < height; row++) {
    lines.push(gel[row].join(''));
  }
  lines.push(labelLine.join(''));

  return lines;
}
```

### Why This Is a Good Idea

1. **Bridges Wet Lab and Dry Lab**: Many researchers still plan experiments using restriction analysis. This tool lets them predict results before touching a pipette, saving time and reagents.

2. **Historical Context**: Restriction mapping was THE technique for studying genomes before sequencing became cheap. Understanding it provides perspective on molecular biology's history.

3. **Visual Verification**: Comparing an actual gel photo to the predicted pattern is a powerful way to verify phage identity or detect unexpected rearrangements.

4. **Teaching Tool**: The relationship between sequence, cut sites, and band patterns is foundational. Seeing it interactively builds intuition faster than static diagrams.

5. **Practical Utility**: For cloning, identifying unique restriction sites, or designing Southern blots, this tool provides immediately actionable information.

### Innovation Assessment

**Novelty: 6/10 (Medium)**

Virtual gel simulation is not new — many web tools and standalone programs exist (NEBcutter, RestrictionMapper). However:
- TUI implementation with ASCII art is novel
- Integration into a phage-focused genome browser is valuable
- Multi-genome comparison in single view is useful
- Real-time updates as you select enzymes is engaging

### Pedagogical Value: 8/10

Strong teaching value for:
- **Restriction enzymes**: Recognition, cutting mechanism, frequency
- **Log-linear relationship**: Why smaller fragments move faster
- **Gel interpretation**: Reading patterns, estimating sizes
- **Experimental design**: Choosing enzymes, predicting results
- **Molecular biology history**: The pre-sequencing era

### Cool/Wow Factor: 7/10

There's something satisfying about seeing a virtual gel appear in the terminal. The instant feedback when changing enzymes or comparing phages creates an engaging experience. While not as visually striking as some features, the practical utility adds value.

### TUI Visualization

```
╭─────────────────────────────────────────────────────────────────────────────╮
│  VIRTUAL GEL ELECTROPHORESIS                                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Enzyme: [EcoRI]  ▼    Gel: [1.0%]  ▼    Add Enzyme: [+]                   │
│                                                                             │
│  Cut Map (Lambda - EcoRI):                                                  │
│  0kb    5kb    10kb   15kb   20kb   25kb   30kb   35kb   40kb   45kb  48kb │
│  [─────│──────│─────────────│──────────────│────────────────│──────────]   │
│  6 EcoRI cut sites: 21,226 | 26,104 | 31,747 | 39,168 | 44,972 | 48,502   │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │   ▼           ▼           ▼           ▼                             │    │
│  │  Ladder     Lambda       T4          T7                             │    │
│  │                                                                     │    │
│  │  ━━━━ 23kb   ████                                                   │    │
│  │  ━━━━ 10kb            ████                                          │    │
│  │                       ████                                          │    │
│  │  ━━━━  6kb   ████     ████         ████                             │    │
│  │  ━━━━  4kb   ██       ████████     ████████                         │    │
│  │             ████      ████████     ████████                         │    │
│  │  ━━━━  2kb   ██       ██████       ██████                           │    │
│  │             ██        ████         ████                             │    │
│  │  ━━━━  1kb   █        ██           ██                               │    │
│  │              █        ██           ██                               │    │
│  │  ━━━━ 0.5kb           ██                                            │    │
│  │                                                                     │    │
│  │             ─────────────────────────────────────────               │    │
│  │             (Front)                                                 │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  Lambda Fragments (EcoRI): 21,226 | 7,421 | 5,804 | 5,643 | 4,878 | 3,530  │
│  Total: 6 fragments | Largest: 21.2 kb | Smallest: 3.5 kb                   │
│                                                                             │
│  [E] Change enzyme  [A] Add sample  [D] Double digest  [S] Save  [ESC] Exit │
╰─────────────────────────────────────────────────────────────────────────────╯
```

**Double Digest View:**
```
╭─────────────────────────────────────────────────────────────────────────────╮
│  DOUBLE DIGEST: Lambda × EcoRI + HindIII                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│     Ladder    EcoRI      HindIII    Double                                  │
│        ▼        ▼          ▼          ▼                                     │
│                                                                             │
│  23kb  ━━     ████                                                          │
│  10kb  ━━                  ████                                             │
│   6kb  ━━     ████         ████       ██                                    │
│   4kb  ━━     ██           ██         ████                                  │
│   2kb  ━━     ██           ██         ████████                              │
│   1kb  ━━     █            ██         ██████                                │
│ 0.5kb  ━━                  █          ████                                  │
│                                       ██                                    │
│                                                                             │
│  Double digest increases resolution (more, smaller fragments)               │
│                                                                             │
╰─────────────────────────────────────────────────────────────────────────────╯
```

---

## 27) Self-Homology Dot Plot (Matrix)

### Concept

The Self-Homology Dot Plot compares a genome against itself to reveal internal structure: direct repeats, inverted repeats (hairpins), tandem duplications, and palindromes. This classic bioinformatics visualization remains one of the most powerful tools for understanding sequence organization.

**The method:**
- X-axis and Y-axis both represent the genome sequence
- A dot at (x,y) indicates that the sequence at position x matches the sequence at position y
- The main diagonal is always solid (sequence matches itself)
- Off-diagonal features reveal repeats and structural elements

**What patterns mean:**
- **Parallel diagonal lines**: Direct repeats (duplicated sequences in same orientation)
- **Perpendicular lines**: Inverted repeats (hairpin/stem-loop structures)
- **Short perpendicular streaks**: Palindromes
- **Dense clusters**: Repeat-rich regions (often regulatory)
- **Empty regions**: Unique sequences with no internal homology

**Why this matters for phages:**
- **Terminal repeats**: Many phages have direct terminal repeats (DTR) for circularization
- **Attachment sites (attP/attB)**: Contain inverted repeats recognized by integrases
- **Regulatory palindromes**: Operator sequences often are palindromic for homodimer binding
- **Recombination hotspots**: Repeated sequences facilitate rearrangements

### Mathematical Foundations

**Window-Based Matching:**
```
For positions i, j in sequence S:
  Match(i, j, w) = true if:
    similarity(S[i:i+w], S[j:j+w]) ≥ threshold

Common similarity measures:
  - Exact: count identical positions ≥ threshold
  - Hamming: (w - hamming_distance) / w ≥ threshold
  - BLOSUM: substitution matrix score ≥ threshold (for proteins)

Typical parameters:
  Window w = 10-20 bp
  Threshold = 80-90% identity
```

**Efficient Computation:**
```
Naive approach: O(n² × w) - compare all pairs
Better approach: Hash-based indexing

For k-mer indexing:
  1. Build hash table of all k-mers and positions
  2. For each k-mer, all position pairs are potential matches
  3. Extend matches to full window
  Complexity: O(n × k) + O(matches × w)

For sparse matrices:
  Store only matches, not the full n×n grid
```

**Inverted Repeat Detection:**
```
For detecting hairpins:
  Compare position i with reverse_complement(j)

Watson-Crick complementarity:
  A ↔ T, C ↔ G

Reverse complement of "GAATTC" = "GAATTC" (palindrome!)
Reverse complement of "ATCG" = "CGAT"
```

### Implementation Approach

```typescript
interface DotPlotConfig {
  windowSize: number;      // Minimum match length
  threshold: number;       // Minimum similarity (0-1)
  maxDots: number;         // Limit for display
  includeInverted: boolean; // Also detect inverted repeats
}

interface DotPlotResult {
  matches: Match[];
  directRepeats: RepeatRegion[];
  invertedRepeats: RepeatRegion[];
  palindromes: number[];
}

interface Match {
  x: number;
  y: number;
  length: number;
  inverted: boolean;
}

function computeDotPlot(
  sequence: string,
  config: DotPlotConfig
): DotPlotResult {
  const { windowSize, threshold, includeInverted } = config;
  const matches: Match[] = [];
  const n = sequence.length;

  // Build k-mer index
  const kmerSize = Math.min(windowSize, 12);
  const index = new Map<string, number[]>();

  for (let i = 0; i <= n - kmerSize; i++) {
    const kmer = sequence.slice(i, i + kmerSize);
    const positions = index.get(kmer) ?? [];
    positions.push(i);
    index.set(kmer, positions);
  }

  // Find matches from k-mer hits
  for (const [kmer, positions] of index.entries()) {
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const x = positions[i];
        const y = positions[j];

        // Extend match
        const matchLen = extendMatch(sequence, x, y, windowSize);
        if (matchLen >= windowSize) {
          matches.push({ x, y, length: matchLen, inverted: false });
        }
      }
    }
  }

  // Detect inverted repeats
  if (includeInverted) {
    const rcSeq = reverseComplement(sequence);
    const rcIndex = new Map<string, number[]>();

    for (let i = 0; i <= n - kmerSize; i++) {
      const kmer = rcSeq.slice(i, i + kmerSize);
      const positions = rcIndex.get(kmer) ?? [];
      positions.push(n - i - kmerSize);  // Map back to original coordinates
      rcIndex.set(kmer, positions);
    }

    for (const [kmer, rcPositions] of rcIndex.entries()) {
      const fwdPositions = index.get(kmer) ?? [];
      for (const x of fwdPositions) {
        for (const y of rcPositions) {
          if (x !== y) {
            matches.push({ x, y, length: windowSize, inverted: true });
          }
        }
      }
    }
  }

  return {
    matches,
    directRepeats: findRepeatRegions(matches.filter(m => !m.inverted)),
    invertedRepeats: findRepeatRegions(matches.filter(m => m.inverted)),
    palindromes: findPalindromes(sequence, 6)
  };
}

function reverseComplement(seq: string): string {
  const complement: Record<string, string> = {
    'A': 'T', 'T': 'A', 'C': 'G', 'G': 'C', 'N': 'N'
  };
  return seq.split('').reverse()
    .map(c => complement[c.toUpperCase()] ?? 'N').join('');
}

// Render using Braille for high resolution
function renderDotPlotBraille(
  result: DotPlotResult,
  seqLength: number,
  width: number,
  height: number
): string[] {
  const grid = new Uint8Array(width * 4 * height * 2);
  const scale = seqLength / (width * 2);

  for (const match of result.matches) {
    const px = Math.floor(match.x / scale);
    const py = Math.floor(match.y / scale);
    if (px < width * 2 && py < height * 4) {
      grid[py * width * 2 + px] = match.inverted ? 2 : 1;
    }
  }

  // Convert to Braille
  const lines: string[] = [];
  for (let charY = 0; charY < height; charY++) {
    let line = '';
    for (let charX = 0; charX < width; charX++) {
      let braille = 0x2800;
      for (let dy = 0; dy < 4; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const val = grid[(charY * 4 + dy) * width * 2 + charX * 2 + dx];
          if (val > 0) {
            braille |= BRAILLE_DOTS[dy][dx];
          }
        }
      }
      line += String.fromCharCode(braille);
    }
    lines.push(line);
  }
  return lines;
}
```

### Why This Is a Good Idea

1. **Canonical Tool**: Dot plots are a fundamental bioinformatics technique taught in every introductory course. Having one built-in makes Phage Explorer a complete educational platform.

2. **Reveals Hidden Structure**: Many important genomic features (terminal repeats, att sites, regulatory palindromes) are instantly visible in dot plots but require complex searches to find otherwise.

3. **Alignment-Free**: Unlike BLAST or similar tools, dot plots don't require choosing parameters or dealing with alignment artifacts. What you see is exactly what's in the sequence.

4. **Visual Pattern Recognition**: Humans are excellent at spotting patterns in 2D images. Dot plots leverage this for rapid structural analysis.

5. **Diagnostic Power**: Unusual patterns (missing diagonal stretches, unexpected repeats) immediately flag rearrangements, deletions, or assembly errors.

### Innovation Assessment

**Novelty: 5/10 (Medium)**

Dot plots are standard tools, available in many programs. However:
- Braille-based TUI rendering is novel
- Integration with phage-specific analysis (att sites, terminal repeats) adds value
- Interactive zoom and annotation is useful

### Pedagogical Value: 9/10

Extremely high for teaching:
- **Sequence comparison fundamentals**
- **Repeat biology**: Why genomes have repeats, what they do
- **Structural genomics**: Hairpins, palindromes, regulatory elements
- **Pattern recognition**: Training eyes to see biological meaning

### Cool/Wow Factor: 7/10

Seeing the entire genome's internal structure in one image is powerful. The distinct patterns for different features (diagonal lines, perpendicular crosses) create an intuitive visual language.

### TUI Visualization

```
╭─────────────────────────────────────────────────────────────────────────────╮
│  SELF-HOMOLOGY DOT PLOT: Lambda Phage (48,502 bp)                           │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Window: 15 bp | Threshold: 85% | ● Direct | ○ Inverted                    │
│                                                                             │
│      0kb       10kb      20kb      30kb      40kb      48kb                │
│  0   ┌──────────────────────────────────────────────────────┐ 0             │
│      │⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│               │
│      │⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│               │
│ 10   │⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│               │
│      │⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│               │
│      │⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│               │
│ 20   │⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│               │
│      │⠀⠀⠀⠀⠀⠀⣿⣀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│  attP site    │
│      │⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│  (inverted)   │
│ 30   │⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│               │
│      │⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠈⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│               │
│      │⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠈⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│               │
│ 40   │⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀│               │
│      │⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⠀⠀⠀⠀⠀│ cos site      │
│ 48   │⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣿⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣀⣿⣿⠀⠀⠀⠀⠀⠀│ (direct)      │
│      └──────────────────────────────────────────────────────┘ 48            │
│       0kb       10kb      20kb      30kb      40kb      48kb                │
│                                                                             │
│  Detected: 2 inverted repeats (attP), 1 direct repeat (cos termini)         │
│                                                                             │
│  [+/-] Zoom  [W] Window size  [T] Threshold  [I] Toggle inverted  [ESC] Exit│
╰─────────────────────────────────────────────────────────────────────────────╯
```

---

## 28) Non-B DNA Structure Map (G4, Z-DNA)

### Concept

DNA isn't always the canonical B-form double helix. Under certain sequence and environmental conditions, it adopts alternative conformations with profound regulatory implications:

**G-Quadruplexes (G4):**
- Four-stranded structures formed by G-rich sequences
- Four guanines form a planar "G-tetrad" via Hoogsteen bonding
- Tetrads stack to form remarkably stable structures
- Found in telomeres, promoters, and 5' UTRs
- In phages: regulate gene expression, affect DNA packaging

**Z-DNA:**
- Left-handed helix (vs right-handed B-DNA)
- Forms in alternating purine-pyrimidine sequences, especially (CG)n
- Recognized by Z-DNA binding proteins (ZBP1/DAI)
- Triggers innate immune responses — important for viral detection
- In phages: may be immune evasion targets

**Other non-B structures:**
- **Cruciform DNA**: At inverted repeats, DNA extrudes into cross-shaped structure
- **H-DNA (triplex)**: Three-stranded structure in mirror repeat sequences
- **Slipped structures**: At tandem repeats

### Mathematical Foundations

**G4 Pattern Recognition:**
```
Classic G4 motif:
  G{3,}N{1,7}G{3,}N{1,7}G{3,}N{1,7}G{3,}

Where:
  G{3,} = 3+ consecutive guanines (one "G-run")
  N{1,7} = 1-7 any nucleotides (loop)

Stability prediction (G4Hunter):
  Score = Σ (G_contribution - C_contribution) / window_size

  G-runs contribute +1 to +4 based on length
  C-runs contribute -1 to -4 (complementary strand G4)

  Score > 1.5: likely G4
  Score > 2.0: strong G4
```

**Z-DNA Propensity:**
```
Z-score for dinucleotide XY:
  CG: +1.0 (highest Z-forming)
  CA/TG: +0.5
  GC: +0.4
  AT/TA: -0.1 (disfavored)
  AA/TT: -0.5 (strongly disfavored)

Z-DNA propensity over window:
  P_Z = Σ Z_score(dinucleotide_i) / window_size

Threshold: P_Z > 0.5 suggests Z-DNA potential
```

**Free Energy of G4 Formation:**
```
ΔG = ΔG_stacking + ΔG_loop + ΔG_ion

Stacking (per tetrad): ~ -10 kcal/mol
Loop penalty: depends on length (1-3 bp: -1 to -3 kcal/mol)
K+ stabilization: ~ -2 kcal/mol per K+ ion

More negative ΔG = more stable G4
```

### Implementation Approach

```typescript
interface NonBStructure {
  type: 'G4' | 'Z-DNA' | 'cruciform' | 'triplex';
  start: number;
  end: number;
  strand: '+' | '-' | 'both';
  score: number;
  sequence: string;
  loops?: number[];  // Loop lengths for G4
}

interface NonBAnalysisResult {
  structures: NonBStructure[];
  g4Count: number;
  zDnaCount: number;
  totalNonBFraction: number;
}

// G4 detection using G4Hunter algorithm
function detectG4(sequence: string, windowSize: number = 25): NonBStructure[] {
  const structures: NonBStructure[] = [];
  const scores = new Float32Array(sequence.length);

  // Compute G4Hunter scores
  for (let i = 0; i < sequence.length - windowSize; i++) {
    const window = sequence.slice(i, i + windowSize).toUpperCase();
    let score = 0;
    let gRun = 0, cRun = 0;

    for (const base of window) {
      if (base === 'G') {
        gRun++;
        if (cRun > 0) { score -= Math.min(cRun, 4); cRun = 0; }
      } else if (base === 'C') {
        cRun++;
        if (gRun > 0) { score += Math.min(gRun, 4); gRun = 0; }
      } else {
        if (gRun > 0) { score += Math.min(gRun, 4); gRun = 0; }
        if (cRun > 0) { score -= Math.min(cRun, 4); cRun = 0; }
      }
    }
    if (gRun > 0) score += Math.min(gRun, 4);
    if (cRun > 0) score -= Math.min(cRun, 4);

    scores[i] = score / windowSize;
  }

  // Find regions above threshold
  const threshold = 1.5;
  let inRegion = false;
  let regionStart = 0;

  for (let i = 0; i < scores.length; i++) {
    if (Math.abs(scores[i]) > threshold && !inRegion) {
      inRegion = true;
      regionStart = i;
    } else if (Math.abs(scores[i]) <= threshold && inRegion) {
      inRegion = false;
      structures.push({
        type: 'G4',
        start: regionStart,
        end: i + windowSize,
        strand: scores[regionStart] > 0 ? '+' : '-',
        score: Math.max(...Array.from(scores.slice(regionStart, i)).map(Math.abs)),
        sequence: sequence.slice(regionStart, i + windowSize)
      });
    }
  }

  return structures;
}

// Z-DNA detection
function detectZDNA(sequence: string, windowSize: number = 12): NonBStructure[] {
  const structures: NonBStructure[] = [];
  const zScores: Record<string, number> = {
    'CG': 1.0, 'GC': 0.4, 'CA': 0.5, 'TG': 0.5,
    'AC': 0.5, 'GT': 0.5, 'AT': -0.1, 'TA': -0.1,
    'AA': -0.5, 'TT': -0.5, 'AG': 0.0, 'CT': 0.0,
    'GA': 0.0, 'TC': 0.0, 'CC': -0.3, 'GG': -0.3
  };

  for (let i = 0; i < sequence.length - windowSize; i++) {
    const window = sequence.slice(i, i + windowSize).toUpperCase();
    let score = 0;

    for (let j = 0; j < window.length - 1; j++) {
      const dinuc = window.slice(j, j + 2);
      score += zScores[dinuc] ?? 0;
    }

    if (score / windowSize > 0.5) {
      structures.push({
        type: 'Z-DNA',
        start: i,
        end: i + windowSize,
        strand: 'both',
        score: score / windowSize,
        sequence: window
      });
    }
  }

  return mergeOverlapping(structures);
}
```

### Why This Is a Good Idea

1. **Cutting-Edge Biology**: G-quadruplex research is one of the hottest areas in nucleic acid biology. Many researchers don't have easy access to G4 prediction tools.

2. **Immune Implications**: Z-DNA triggers innate immunity via ZBP1. For therapeutic phages, knowing where Z-DNA forms could be crucial for avoiding immune clearance.

3. **Regulatory Insights**: G4s in promoter regions often regulate transcription. Identifying them helps understand phage gene expression programs.

4. **Packaging Considerations**: Non-B structures may affect DNA flexibility and packaging efficiency — relevant for phage therapy production.

5. **Novel Perspective**: Standard genome browsers ignore DNA structure. Adding this layer provides unique analytical capability.

### Innovation Assessment

**Novelty: 8/10 (High)**

G4 prediction tools exist (G4Hunter, QGRS Mapper) but:
- They're standalone web tools, not integrated into genome browsers
- Z-DNA prediction is rarely included
- TUI integration is novel
- Phage-specific context (packaging, therapy) is new

### Pedagogical Value: 8/10

Teaches important concepts:
- **Non-canonical DNA structures**: Beyond the textbook double helix
- **Regulatory biology**: How structure affects function
- **Pattern recognition**: What makes a G4 motif
- **Biophysics**: Why certain sequences adopt alternative conformations

### Cool/Wow Factor: 7/10

The idea that DNA can form weird structures beyond the double helix is genuinely surprising to many. Visualizing these "danger zones" on the genome adds an element of discovery.

### TUI Visualization

```
╭─────────────────────────────────────────────────────────────────────────────╮
│  NON-B DNA STRUCTURE MAP: T7 Phage                                          │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Genome Track (39,937 bp):                                                  │
│  ══════════════════════════════════════════════════════════════════════════ │
│                                                                             │
│  G4 (+ strand):    ──────⬡──────────────────⬡─────────────⬡⬡────────────── │
│                           ↑                  ↑             ↑↑                │
│                        Promoter?           5' UTR       Regulatory?        │
│                                                                             │
│  G4 (- strand):    ────────────⬢────────────────────⬢──────────────────── │
│                               ↑                     ↑                       │
│                            Potential             Strong                     │
│                                                                             │
│  Z-DNA:            ─────────────────────[ZZZ]─────────────[ZZZZ]────────── │
│                                            ↑                ↑                │
│                                         Moderate         Strong             │
│                                                                             │
│  ─────────────────────────────────────────────────────────────────────────  │
│                                                                             │
│  Structure Details:                                                         │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │ Position  │ Type   │ Score │ Sequence                                  │ │
│  ├────────────────────────────────────────────────────────────────────────┤ │
│  │  2,341    │ G4(+)  │  2.3  │ GGGTTGGGTTTGGGTTTGGG                       │ │
│  │  8,492    │ G4(+)  │  1.8  │ GGGGACGGGACGGGACGGGG                       │ │
│  │ 15,221    │ Z-DNA  │  0.7  │ CGCGCGCGCGCG                               │ │
│  │ 22,108    │ G4(-)  │  2.1  │ (complementary strand)                     │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  Summary: 6 G4 motifs (4 strong) | 2 Z-DNA regions                          │
│  Coverage: 0.3% of genome in potential non-B structures                     │
│                                                                             │
│  [G] Toggle G4  [Z] Toggle Z-DNA  [D] Details  [E] Export  [ESC] Exit       │
╰─────────────────────────────────────────────────────────────────────────────╯
```

---

## 29) Genomic Signature PCA (Tetranucleotide Frequency)

### Concept

Every genome has a characteristic "signature" — a unique pattern of k-mer frequencies that reflects its evolutionary history, GC content, codon usage, and other constraints. By computing tetranucleotide (4-mer) frequencies for all phages and projecting them into a 2D space using Principal Component Analysis (PCA), we can visualize phylogenetic relationships **without sequence alignment**.

**The power of genomic signatures:**
- Alignment-free comparison — works even for divergent sequences
- Captures global composition, not just individual gene homology
- Robust to rearrangements, insertions, deletions
- Fast to compute — O(n) per genome

**What the PCA reveals:**
- **Clustering by family**: Related phages cluster together
- **Host adaptation**: Phages infecting the same host often cluster (due to shared codon biases)
- **Outliers**: Unusual phages or chimeric genomes stand out
- **GC islands**: Horizontally transferred regions have different signatures

### Mathematical Foundations

**Tetranucleotide Frequency Vector:**
```
For a genome S of length L:
  Count each 4-mer: freq(AAAA), freq(AAAC), ..., freq(TTTT)
  Total 4-mers: 4⁴ = 256 possibilities

Normalize by total count:
  f(k) = count(k) / (L - 3)

Or by expected (GC-adjusted):
  f_observed(k) / f_expected(k)
  where f_expected(k) = p(n1) × p(n2) × p(n3) × p(n4)
```

**Principal Component Analysis:**
```
Given N phages, each with 256-dim frequency vector:
  Data matrix X: N × 256

1. Center the data:
   X_centered = X - mean(X, axis=0)

2. Compute covariance matrix:
   C = (1/N) × X_centeredᵀ × X_centered  [256 × 256]

3. Eigendecomposition:
   C = V × Λ × Vᵀ
   where Λ = diagonal matrix of eigenvalues
         V = matrix of eigenvectors

4. Project to 2D:
   PC1 = X_centered × v₁
   PC2 = X_centered × v₂
   where v₁, v₂ are top 2 eigenvectors
```

**Variance Explained:**
```
Variance explained by PCk = λₖ / Σλᵢ

Typically for genomic signatures:
  PC1: 30-50% (often correlates with GC content)
  PC2: 10-20% (often reflects purine/pyrimidine bias)
  PC3+: Increasingly specific patterns
```

**Distance in PCA Space:**
```
Euclidean distance between phages i and j:
  d(i,j) = √((PC1ᵢ - PC1ⱼ)² + (PC2ᵢ - PC2ⱼ)²)

This correlates with:
  - Taxonomic distance
  - Host range overlap
  - Time since divergence
```

### Implementation Approach

```typescript
interface KmerVector {
  phageId: number;
  name: string;
  frequencies: Float32Array;  // 256 elements for 4-mers
  gcContent: number;
}

interface PCAResult {
  projections: { phageId: number; name: string; pc1: number; pc2: number }[];
  eigenvalues: number[];
  varianceExplained: number[];
  loadings: Float32Array[];  // Which 4-mers contribute to each PC
}

// Compute 4-mer frequencies for a sequence
function computeKmerFrequencies(sequence: string): Float32Array {
  const counts = new Uint32Array(256);  // 4^4 = 256
  const baseToNum: Record<string, number> = { 'A': 0, 'C': 1, 'G': 2, 'T': 3 };

  for (let i = 0; i <= sequence.length - 4; i++) {
    let index = 0;
    let valid = true;

    for (let j = 0; j < 4; j++) {
      const base = sequence[i + j].toUpperCase();
      const num = baseToNum[base];
      if (num === undefined) { valid = false; break; }
      index = index * 4 + num;
    }

    if (valid) counts[index]++;
  }

  // Normalize to frequencies
  const total = sequence.length - 3;
  const frequencies = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    frequencies[i] = counts[i] / total;
  }

  return frequencies;
}

// Perform PCA on the frequency matrix
function computePCA(vectors: KmerVector[]): PCAResult {
  const n = vectors.length;
  const d = 256;

  // Center the data
  const mean = new Float32Array(d);
  for (const v of vectors) {
    for (let i = 0; i < d; i++) {
      mean[i] += v.frequencies[i] / n;
    }
  }

  const centered = vectors.map(v => {
    const c = new Float32Array(d);
    for (let i = 0; i < d; i++) {
      c[i] = v.frequencies[i] - mean[i];
    }
    return c;
  });

  // SVD-based PCA (more numerically stable than covariance)
  // Using power iteration for simplicity
  const pc1 = powerIteration(centered, d);
  const pc2 = powerIterationDeflated(centered, d, pc1);

  // Project data
  const projections = vectors.map((v, i) => ({
    phageId: v.phageId,
    name: v.name,
    pc1: dotProduct(centered[i], pc1),
    pc2: dotProduct(centered[i], pc2)
  }));

  return {
    projections,
    eigenvalues: [computeVariance(projections.map(p => p.pc1)),
                   computeVariance(projections.map(p => p.pc2))],
    varianceExplained: [0.4, 0.15],  // Placeholder
    loadings: [pc1, pc2]
  };
}

// Render scatter plot in TUI
function renderPCAPlot(
  result: PCAResult,
  width: number,
  height: number,
  highlightId?: number
): string[] {
  const { projections } = result;
  const lines: string[] = [];

  // Find bounds
  const pc1Values = projections.map(p => p.pc1);
  const pc2Values = projections.map(p => p.pc2);
  const minPC1 = Math.min(...pc1Values), maxPC1 = Math.max(...pc1Values);
  const minPC2 = Math.min(...pc2Values), maxPC2 = Math.max(...pc2Values);

  // Initialize grid
  const grid: string[][] = Array(height).fill(0)
    .map(() => Array(width).fill(' '));

  // Plot points
  for (const p of projections) {
    const x = Math.floor(((p.pc1 - minPC1) / (maxPC1 - minPC1)) * (width - 1));
    const y = Math.floor(((maxPC2 - p.pc2) / (maxPC2 - minPC2)) * (height - 1));

    if (x >= 0 && x < width && y >= 0 && y < height) {
      const char = p.phageId === highlightId ? '◉' : '●';
      grid[y][x] = char;
    }
  }

  // Add axes
  for (let y = 0; y < height; y++) grid[y][0] = '│';
  for (let x = 0; x < width; x++) grid[height - 1][x] = '─';
  grid[height - 1][0] = '└';

  return grid.map(row => row.join(''));
}
```

### Why This Is a Good Idea

1. **Instant Phylogenetics**: Without running BLAST, building alignments, or constructing trees, users can immediately see how phages relate to each other. A 10-second computation replaces hours of traditional analysis.

2. **Host Prediction**: Phages adapting to the same host develop similar codon biases. PCA clustering can suggest potential hosts for novel phages.

3. **Anomaly Detection**: A phage that doesn't cluster with its supposed family might be misclassified, chimeric, or genuinely novel.

4. **Educational Clarity**: PCA is a fundamental data science technique. Applying it to genomics teaches multivariate analysis in a biological context.

5. **Interactive Exploration**: Click on a point to see which phage it represents. Zoom into clusters. Compare your phage to known references.

### Innovation Assessment

**Novelty: 7/10 (High)**

Tetranucleotide PCA is a known technique but:
- Rarely available in user-facing phage tools
- TUI scatter plot visualization is creative
- Integration with genome browser is valuable
- Interactive exploration adds usability

### Pedagogical Value: 9/10

Excellent for teaching:
- **Dimensionality reduction**: Why and how PCA works
- **Genomic signatures**: What makes organisms "feel" different
- **Alignment-free methods**: Alternatives to BLAST
- **Data visualization**: Interpreting scatter plots
- **Multivariate statistics**: Eigenvalues, variance explained

### Cool/Wow Factor: 8/10

Seeing all your phages plotted in a 2D space where proximity = relatedness is satisfying. The "aha" moment when students realize that genome composition alone can reveal evolutionary relationships is powerful.

### TUI Visualization

```
╭─────────────────────────────────────────────────────────────────────────────╮
│  GENOMIC SIGNATURE PCA: Tetranucleotide Frequencies                         │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  PC1 (43.2% variance) vs PC2 (16.7% variance)                               │
│                                                                             │
│  PC2 ↑                                                                      │
│      │                                                                      │
│  0.3 │                    ●T7                                               │
│      │                   ● ●                   ●Phi29                       │
│  0.2 │                  ●   (T7-like)            ●                          │
│      │                 ●                                                    │
│  0.1 │                                                                      │
│      │  ●MS2                                                                │
│  0.0 │───────────────────────────────────●Lambda───────────────→ PC1        │
│      │       ●PhiX174                        ●                              │
│ -0.1 │         (ssDNA cluster)              ●P22                            │
│      │      ●M13                                                            │
│ -0.2 │                                                                      │
│      │                                        ◉ YOU ARE HERE                │
│ -0.3 │                           ●T4           (T4-like cluster)            │
│      │                          ●SPbeta ●T5                                 │
│ -0.4 └──────────────────────────────────────────────────────────            │
│     -0.4  -0.3  -0.2  -0.1   0.0   0.1   0.2   0.3   0.4   0.5              │
│                                                                             │
│  Clusters detected:                                                         │
│  ├─ T7-like: T7, SP6 (high GC, similar codon usage)                         │
│  ├─ T4-like: T4, T5, SPbeta (AT-rich, large genomes)                        │
│  ├─ ssDNA: PhiX174, M13 (distinct composition)                              │
│  └─ Lambda-like: Lambda, P22 (temperate phages)                             │
│                                                                             │
│  [Click point] Inspect  [Z] Zoom  [3] Add PC3  [E] Export  [ESC] Exit       │
╰─────────────────────────────────────────────────────────────────────────────╯
```

---

## 30) Plaque Morphology Cellular Automata

### Concept

The Plaque Morphology Simulator uses a cellular automaton to model how phage plaques form and grow on a bacterial lawn. By inputting phage parameters (burst size, latent period, diffusion rate), users watch virtual plaques develop in real-time — connecting genotype to phenotype in an engaging visual simulation.

**The biology of plaque formation:**
- Bacteria grow as a "lawn" on solid media
- A single phage particle infects one bacterium
- After the **latent period**, the cell lyses, releasing **burst size** new phages
- Phages diffuse outward and infect neighboring cells
- The process repeats, creating an expanding zone of dead bacteria (the plaque)

**What determines plaque morphology:**
- **Clear plaques**: Virulent phages that always lyse
- **Turbid plaques**: Temperate phages; some lysogens survive in the center
- **Large plaques**: Long latent period (more time to diffuse before lysis)
- **Small plaques**: Short latent period (cells lyse before diffusion)
- **Halo plaques**: Phages with depolymerase activity

### Mathematical Foundations

**Reaction-Diffusion Model:**
```
State variables at grid position (x,y) and time t:
  B(x,y,t) = bacteria density [0, 1]
  I(x,y,t) = infected cell count
  P(x,y,t) = free phage particles

Equations:
  ∂B/∂t = r×B×(1-B) - k×B×P        [growth - infection]
  ∂I/∂t = k×B×P - (1/τ)×I          [infection - lysis]
  ∂P/∂t = D×∇²P + b×(1/τ)×I - δ×P  [diffusion + burst - decay]

Parameters:
  r = bacterial growth rate
  k = adsorption rate constant
  τ = latent period
  b = burst size
  D = phage diffusion coefficient
  δ = phage decay rate
```

**Cellular Automaton Simplification:**
```
For each cell in grid at each time step:
  If BACTERIA:
    If adjacent PHAGE: become INFECTED with probability p
    Else: stay BACTERIA (or divide with probability g)

  If INFECTED:
    age += 1
    If age >= latent_period:
      become LYSED
      spawn burst_size PHAGE particles nearby

  If LYSED:
    stay LYSED (dead cell)

  If PHAGE:
    diffuse to random adjacent cell
    decay with probability d
```

**Plaque Size Prediction:**
```
Final plaque radius R after time T:
  R ≈ √(4 × D × T × efficiency)

where efficiency depends on:
  - Burst size (more phages = faster spreading)
  - Latent period (longer = more diffusion time)
  - Adsorption rate (higher = faster infection)

Empirical relationship:
  Plaque area ∝ (burst_size × latent_period × D) / adsorption
```

### Implementation Approach

```typescript
type CellState = 'empty' | 'bacteria' | 'infected' | 'lysed' | 'lysogen';

interface PlaqueSimConfig {
  gridSize: number;           // NxN grid
  burstSize: number;          // Phages released per lysis
  latentPeriod: number;       // Ticks until lysis
  diffusionRate: number;      // Phage movement per tick
  adsorptionProb: number;     // Infection probability
  lysogenyProb: number;       // Probability of becoming lysogen (temperate)
  bacteriaGrowthRate: number; // Division probability
}

interface SimulationCell {
  state: CellState;
  phageCount: number;
  infectionAge: number;
}

function initializePlaqueSim(config: PlaqueSimConfig): SimulationCell[][] {
  const { gridSize } = config;
  const grid: SimulationCell[][] = [];

  for (let y = 0; y < gridSize; y++) {
    const row: SimulationCell[] = [];
    for (let x = 0; x < gridSize; x++) {
      row.push({
        state: 'bacteria',
        phageCount: 0,
        infectionAge: 0
      });
    }
    grid.push(row);
  }

  // Seed initial phage at center
  const center = Math.floor(gridSize / 2);
  grid[center][center].phageCount = 1;

  return grid;
}

function simulateTick(
  grid: SimulationCell[][],
  config: PlaqueSimConfig
): SimulationCell[][] {
  const { gridSize, burstSize, latentPeriod, diffusionRate,
          adsorptionProb, lysogenyProb, bacteriaGrowthRate } = config;

  const newGrid = JSON.parse(JSON.stringify(grid)) as SimulationCell[][];

  for (let y = 0; y < gridSize; y++) {
    for (let x = 0; x < gridSize; x++) {
      const cell = grid[y][x];
      const newCell = newGrid[y][x];

      switch (cell.state) {
        case 'bacteria':
          // Check for phage infection
          if (cell.phageCount > 0 && Math.random() < adsorptionProb) {
            if (lysogenyProb > 0 && Math.random() < lysogenyProb) {
              newCell.state = 'lysogen';
            } else {
              newCell.state = 'infected';
              newCell.infectionAge = 0;
            }
            newCell.phageCount--;
          }
          break;

        case 'infected':
          // Lysis after latent period
          newCell.infectionAge++;
          if (newCell.infectionAge >= latentPeriod) {
            newCell.state = 'lysed';
            // Release burst of phages
            distributePhages(newGrid, x, y, burstSize, gridSize);
          }
          break;

        case 'lysed':
          // Dead cells stay dead
          break;

        case 'lysogen':
          // Lysogens are immune and can grow
          // (Occasional induction could be added)
          break;
      }

      // Phage diffusion
      if (cell.phageCount > 0) {
        const phagesToMove = Math.floor(cell.phageCount * diffusionRate);
        for (let p = 0; p < phagesToMove; p++) {
          const [nx, ny] = randomNeighbor(x, y, gridSize);
          newGrid[y][x].phageCount--;
          newGrid[ny][nx].phageCount++;
        }
      }
    }
  }

  return newGrid;
}

function distributePhages(
  grid: SimulationCell[][],
  x: number,
  y: number,
  count: number,
  size: number
): void {
  for (let i = 0; i < count; i++) {
    // Random direction
    const angle = Math.random() * 2 * Math.PI;
    const dist = Math.random() * 3; // Spread within 3 cells
    const nx = Math.round(x + Math.cos(angle) * dist);
    const ny = Math.round(y + Math.sin(angle) * dist);

    if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
      grid[ny][nx].phageCount++;
    }
  }
}

// Render the plaque
function renderPlaque(grid: SimulationCell[][], width: number): string[] {
  const scale = grid.length / width;
  const lines: string[] = [];

  for (let charY = 0; charY < width; charY++) {
    let line = '';
    for (let charX = 0; charX < width; charX++) {
      const gridX = Math.floor(charX * scale);
      const gridY = Math.floor(charY * scale);
      const cell = grid[gridY][gridX];

      switch (cell.state) {
        case 'bacteria': line += '█'; break;
        case 'infected': line += '▓'; break;
        case 'lysed':    line += ' '; break;
        case 'lysogen':  line += '▒'; break;
        default:         line += '░'; break;
      }
    }
    lines.push(line);
  }

  return lines;
}
```

### Why This Is a Good Idea

1. **Genotype-to-Phenotype Connection**: Students see how molecular parameters (burst size, latent period) translate into macroscopic observables (plaque size, turbidity). This bridges the gap between genetic analysis and lab observations.

2. **Interactive Experimentation**: Adjust parameters and immediately see the effect. "What if burst size was 10x higher?" — now you can find out without doing the experiment.

3. **Historical Significance**: Plaque assays were foundational to phage biology (Delbrück, Ellis, Luria). Understanding them provides historical context.

4. **Therapeutic Relevance**: For phage therapy, understanding how phages spread through bacterial populations is crucial for dosing and efficacy predictions.

5. **Engaging Visualization**: Watching a virtual plaque grow is mesmerizing — it's a simulation game embedded in a scientific tool.

### Innovation Assessment

**Novelty: 9/10 (Very High)**

Cellular automata for phage plaques have been described in research papers but:
- No phage genome browser includes this
- Real-time TUI animation is novel
- Interactive parameter adjustment is unique
- Connection to genomic data (burst size prediction from genes) is innovative

### Pedagogical Value: 9/10

Outstanding for teaching:
- **Phage life cycle**: Latent period, burst size, lysis
- **Population dynamics**: How infections spread
- **Mathematical biology**: Reaction-diffusion systems
- **Emergence**: Simple rules creating complex patterns
- **Experimental interpretation**: What plaque morphology tells you

### Cool/Wow Factor: 10/10

This is essentially a video game — watching an infection spread across a bacterial lawn in real-time. The visual feedback when changing parameters creates an addictive "just one more experiment" loop. Exceptional engagement.

### TUI Visualization

```
╭─────────────────────────────────────────────────────────────────────────────╮
│  PLAQUE MORPHOLOGY SIMULATOR: Lambda Phage                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Parameters:         Time: 00:45    Generation: 3                           │
│  ├─ Burst size: 100                                                         │
│  ├─ Latent period: 45 min                                                   │
│  ├─ Lysogeny: 50%                                                           │
│  └─ Diffusion: Medium                                                       │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │█████████████████████████████████████████████████████████████████████│    │
│  │█████████████████████████████████████████████████████████████████████│    │
│  │████████████████████████████▓▓▓██████████████████████████████████████│    │
│  │██████████████████████████▓▓   ▓▓████████████████████████████████████│    │
│  │████████████████████████▓▓  ▒▒  ▓▓██████████████████████████████████│    │
│  │███████████████████████▓  ▒    ▒  ▓█████████████████████████████████│    │
│  │██████████████████████▓ ▒  ▒▒▒  ▒ ▓█████████████████████████████████│    │
│  │█████████████████████▓ ▒ ▒     ▒ ▒ ▓████████████████████████████████│    │
│  │█████████████████████▓ ▒   ▒▒▒  ▒  ▓████████████████████████████████│    │
│  │██████████████████████▓ ▒ ▒   ▒ ▒ ▓█████████████████████████████████│    │
│  │███████████████████████▓  ▒▒▒▒▒  ▓██████████████████████████████████│    │
│  │████████████████████████▓▓     ▓▓███████████████████████████████████│    │
│  │██████████████████████████▓▓▓▓▓█████████████████████████████████████│    │
│  │█████████████████████████████████████████████████████████████████████│    │
│  │█████████████████████████████████████████████████████████████████████│    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  Legend: █ Bacteria | ▓ Infected | (space) Lysed | ▒ Lysogen                │
│                                                                             │
│  Morphology: TURBID (lysogens surviving in center)                          │
│  Predicted size: Medium (2.1 mm at 24h)                                     │
│                                                                             │
│  [Space] Pause  [B/L/D] Adjust params  [R] Reset  [V] Virulent  [ESC] Exit  │
╰─────────────────────────────────────────────────────────────────────────────╯
```

---

## 31) Packaging Motor Physics (Terminase Energy)

### Concept

The phage DNA packaging motor is one of the most powerful molecular machines known — generating forces exceeding 60 piconewtons and internal pressures of ~60 atmospheres to compress DNA into the capsid. This feature visualizes the physics of packaging as users scroll through the genome, showing how force builds as the capsid fills.

**The packaging marvel:**
- Terminase complexes translocate DNA into preformed capsids
- DNA is packed to near-crystalline density (~500 mg/mL)
- The motor burns ~1 ATP per 2 base pairs packaged
- Packaging stalls when internal pressure equals motor force
- This pressure later drives DNA injection into host cells

**What limits packaging:**
- **Bending energy**: DNA resists being bent tightly
- **Electrostatic repulsion**: Negatively charged DNA backbone repels itself
- **Entropy loss**: Organized DNA has lower entropy than free solution
- **Capsid volume**: Fixed space limits DNA amount

### Mathematical Foundations

**Elastic Energy (Bending):**
```
DNA persistence length P ≈ 50 nm

Bending energy for DNA confined to radius R:
  E_bend = (π × k_B × T × L) / (2 × P × R²)

where:
  L = contour length of DNA
  R = effective radius of confinement
  k_B × T = thermal energy ≈ 4.1 pN·nm at 25°C

For Phi29 (19.3 kb, R ≈ 21 nm):
  E_bend ≈ 1000 k_B·T (massive!)
```

**Electrostatic Energy:**
```
DNA has ~2 negative charges per bp (phosphate backbone)
Charges separated by ~0.34 nm

In confined volume, electrostatic energy:
  E_elec = (ρ × L)² × f(salt, geometry)

where ρ = linear charge density

Screening by counterions reduces this, but at high density:
  E_elec ~ 500-1000 k_B·T for typical phages
```

**Entropic Energy:**
```
Loss of configurational entropy:
  ΔS_conf = -k_B × ln(Ω_confined / Ω_free)

  Ω_free ∝ volume^(L/P)  [random coil configurations]
  Ω_confined << Ω_free

Contributes ~500 k_B·T to packaging energy
```

**Force vs Filling:**
```
Total internal force F as function of filling fraction φ:

  F(φ) = F_0 × [1 + α×φ + β×φ² + γ×φ³]

where:
  F_0 ~ 5 pN (at start of packaging)
  α, β, γ are empirical constants

Near completion (φ → 1):
  F → 50-80 pN (measured by optical tweezers)

This is ~10x the stall force of kinesin!
```

**ATP Consumption:**
```
Packaging rate: ~100-200 bp/sec (E. coli phages)
Energy cost: ~1 ATP per 2 bp

For Lambda (48.5 kb):
  Total ATP consumed ≈ 24,000 ATP molecules
  Total energy: ~600,000 k_B·T = ~2,500 kJ/mol
```

### Implementation Approach

```typescript
interface PackagingParams {
  genomeLength: number;    // bp
  capsidRadius: number;    // nm
  persistenceLength: number; // nm (~50 for dsDNA)
  chargesPerBp: number;    // ~2 for dsDNA
  saltConcentration: number; // mM
}

interface PackagingState {
  fillingFraction: number; // 0 to 1
  internalPressure: number; // atmospheres
  force: number;           // piconewtons
  energyStored: number;    // kT units
  atpConsumed: number;     // molecules
}

function computePackagingPhysics(
  position: number,  // Current position in genome
  params: PackagingParams
): PackagingState {
  const { genomeLength, capsidRadius, persistenceLength } = params;

  const fillingFraction = position / genomeLength;
  const packedLength = position * 0.34; // nm (rise per bp)

  // Bending energy (simplified model)
  const effectiveRadius = capsidRadius * Math.pow(1 - fillingFraction, 1/3);
  const bendEnergy = (Math.PI * 4.1 * packedLength) /
                     (2 * persistenceLength * effectiveRadius * effectiveRadius);

  // Electrostatic energy (screened)
  const elecEnergy = 0.5 * fillingFraction * fillingFraction * 1000; // kT

  // Total stored energy
  const totalEnergy = bendEnergy + elecEnergy;

  // Force from energy derivative
  // F = dE/dx where x is filling
  const force = 5 + 50 * Math.pow(fillingFraction, 3); // pN (simplified fit)

  // Internal pressure
  const capsidVolume = (4/3) * Math.PI * Math.pow(capsidRadius, 3); // nm³
  const pressure = (force * packedLength) / capsidVolume * 1e-6; // atm (rough)

  // ATP consumed
  const atpConsumed = Math.floor(position / 2);

  return {
    fillingFraction,
    internalPressure: Math.min(pressure, 60), // Cap at known max
    force,
    energyStored: totalEnergy,
    atpConsumed
  };
}

// Render as pressure gauge
function renderPressureGauge(state: PackagingState, width: number): string[] {
  const lines: string[] = [];
  const { internalPressure, fillingFraction, force } = state;

  // Pressure bar
  const filled = Math.floor(fillingFraction * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);

  // Color based on pressure (ANSI colors)
  let color = '\x1b[32m'; // Green
  if (internalPressure > 30) color = '\x1b[33m'; // Yellow
  if (internalPressure > 50) color = '\x1b[31m'; // Red

  lines.push(`Capsid Fill: ${color}[${bar}]\x1b[0m ${(fillingFraction * 100).toFixed(1)}%`);
  lines.push(`Pressure:    ${internalPressure.toFixed(1)} atm ${internalPressure > 50 ? '⚠️ HIGH' : ''}`);
  lines.push(`Force:       ${force.toFixed(1)} pN`);
  lines.push(`Energy:      ${state.energyStored.toFixed(0)} kT stored`);
  lines.push(`ATP used:    ${state.atpConsumed.toLocaleString()} molecules`);

  return lines;
}
```

### Why This Is a Good Idea

1. **Awe-Inspiring Physics**: The packaging motor is genuinely remarkable — one of the most powerful molecular machines. Highlighting this connects genomics to biophysics in an engaging way.

2. **Scroll-Synchronized Display**: As users scroll through the genome, they "feel" the packaging happening. Position 1 = low pressure; position 48,000 = maximum stress. This creates embodied understanding.

3. **Therapeutic Relevance**: For phage therapy production, understanding packaging limits matters. Genomes that are too long won't package efficiently.

4. **Unique Perspective**: No genome browser shows physical properties like internal pressure. This adds a dimension of analysis that's completely novel.

5. **Connection to Injection**: The stored energy drives DNA injection into host cells — the pressure gauge foreshadows what happens next in the phage life cycle.

### Innovation Assessment

**Novelty: 10/10 (Extremely High)**

This feature has no precedent in any bioinformatics tool. The combination of:
- Real-time pressure calculation synced to scroll position
- Biophysical modeling accessible to non-experts
- Visual pressure gauge in a genome browser
- Educational context about molecular motors

...is completely original.

### Pedagogical Value: 9/10

Teaches fascinating biophysics:
- **Molecular motors**: How biological machines generate force
- **Polymer physics**: Bending, electrostatics, entropy
- **Energy scales**: What kT means, what a piconewton means
- **Biological extremes**: Viruses as engineering marvels
- **Pressure and force**: Intuitive physical concepts in molecular context

### Cool/Wow Factor: 10/10

The "wow" moment when users realize they're scrolling through a spring under 60 atmospheres of pressure is unforgettable. The pressure gauge turning red at the end of the genome creates drama and understanding simultaneously. This is science communication at its best.

### TUI Visualization

```
╭─────────────────────────────────────────────────────────────────────────────╮
│  PACKAGING MOTOR PHYSICS: Lambda Phage                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Current Position: 42,125 / 48,502 bp (86.8% packaged)                      │
│                                                                             │
│  ┌─────────────────────────────────────────────────────────────────────┐    │
│  │                                                                     │    │
│  │   TERMINASE MOTOR                                                   │    │
│  │      ╔═══╗                                                          │    │
│  │  ────╢ ◉ ╟────[DNA]────────────────────────────────────────>        │    │
│  │      ╚═══╝      ↓                                                   │    │
│  │                 ↓                                                   │    │
│  │       ┌─────────────────┐                                           │    │
│  │       │  ░░░░░░░░░░░░░░ │  ← DNA being compressed                   │    │
│  │       │  ░░░░████████░░ │                                           │    │
│  │       │  ░░████████████ │    CAPSID                                 │    │
│  │       │  ░░████████████ │    (filling...)                           │    │
│  │       │  ░░████████████ │                                           │    │
│  │       │  ░░░░████████░░ │                                           │    │
│  │       │  ░░░░░░░░░░░░░░ │                                           │    │
│  │       └─────────────────┘                                           │    │
│  │                                                                     │    │
│  └─────────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│  PRESSURE GAUGE:                                                            │
│  ┌────────────────────────────────────────────────────────────────────┐     │
│  │  0 atm    10      20      30      40      50      60 atm           │     │
│  │  ├─────────┼───────┼───────┼───────┼───────┼───────┤              │     │
│  │  [████████████████████████████████████████░░░░░░░░] 52.3 atm      │     │
│  │                                        ↑                           │     │
│  │                              ⚠️  HIGH PRESSURE ZONE               │     │
│  └────────────────────────────────────────────────────────────────────┘     │
│                                                                             │
│  Motor Stats:                                                               │
│  ├─ Force output:      57.2 pN (motor working hard!)                        │
│  ├─ Energy stored:     892 kT (enough to inject into host)                  │
│  ├─ ATP consumed:      21,063 molecules                                     │
│  └─ Packaging rate:    ~120 bp/sec (slowing down...)                        │
│                                                                             │
│  Note: Internal pressure will drive DNA injection at ~10 µm/sec             │
│                                                                             │
│  [←→] Scroll genome (feel the pressure build!)  [R] Reset  [ESC] Exit       │
╰─────────────────────────────────────────────────────────────────────────────╯
```

---

# Implementation Priority Matrix (Updated Phase 2)

| Feature | Impact | Effort | Priority |
|---------|--------|--------|----------|
| 11. GC Skew | High | Low | **P0** |
| 13. Lysogeny Sim | Very High | Med | **P0** |
| 22. CGR Fractals | High | Low | **P1** |
| 24. Ribosome Traffic | Very High | High | **P1** |
| 25. Intrinsic Curvature | Med | Med | **P2** |
| 26. Virtual Gel | Med | Low | **P2** |
| 30. Plaque Sim | High | High | **P3** |

---

# UI Architecture Recommendations: Integrating 31 Features Without Overwhelming Users

*Analysis and recommendations by Claude — December 2024*

## The Core Challenge

We have 31 sophisticated features spanning:
- Statistical overlays (GC skew, complexity, curvature)
- Full-screen visualizations (CGR fractals, Hilbert curves, dot plots, PCA)
- Interactive simulations (lysogeny circuit, ribosome traffic, plaque growth)
- Comparative analyses (dN/dS, synteny, structural variants)
- Predictions and annotations (host range, AMGs, promoters)
- Utilities (virtual gel, sequence logos)

If we expose all 31 features as top-level keybindings, we get:
- **Cognitive overload**: Users can't remember 31 keys
- **Intimidation**: New users see complexity and leave
- **Accidental triggers**: Typos activate unfamiliar features
- **UI clutter**: Help overlay becomes a wall of text

The existing interface is already excellent — clean, focused, discoverable. We must preserve that while adding depth.

---

## Proposed Architecture: The "Depth Layers" Model

### Layer 0: The Sacred Surface (Keep Untouched)

The current interface represents our **core loop**:
```
↑/↓     Navigate phages       ←/→     Scroll sequence
N/C     DNA/Amino acid view   F       Reading frame
T       Theme cycle           D       Diff mode
M       3D model              K       Amino acid key
S       Search                ?       Help
```

**These 12 controls must never change.** They represent the "5-minute experience" — what users learn in their first session. This is our brand.

### Layer 1: Quick Overlays (Single-Keypress Toggles)

For features that augment the existing view without disrupting it, we add **overlay toggles**. These show additional data tracks beneath/above the sequence grid.

**Proposed quick-toggle keys** (unused in Layer 0):
```
G       GC Skew curve + origin/terminus markers
X       Complexity (Kolmogorov) sparkline
B       Bendability/curvature track
P       Promoter/RBS strength annotations
R       Repeat/palindrome markers
```

**Design principles:**
- Each overlay is **independent** — toggle any combination
- Overlays use **consistent visual language** (sparklines, annotation bars)
- Pressing the key again **hides** the overlay
- Status bar shows active overlays: `[G][X][P]`

**Why this works:**
- Single keypress = zero friction for power users
- Discoverable via `?` help (a separate "Overlays" section)
- Non-destructive — main view unchanged when all off

### Layer 2: The Analysis Menu (Press 'A')

For features requiring configuration, multiple inputs, or dedicated screen real estate, we introduce a **modal menu**.

```
╭─────────────────────────────────────────────────────────────╮
│  ANALYSIS MENU                                    [ESC] Close │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  SEQUENCE ANALYSIS                                           │
│    [1] GC Skew Origin Detector         (overlays origin)     │
│    [2] Information Anomaly Scanner     (find HGT regions)    │
│    [3] Non-B DNA Structures            (G4, Z-DNA)           │
│    [4] Sequence Logo Generator         (from alignment)      │
│                                                              │
│  COMPARATIVE                                                 │
│    [5] Selection Pressure (dN/dS)      (vs another phage)    │
│    [6] Structural Variants             (vs another phage)    │
│    [7] Synteny Browser                 (multi-phage)         │
│    [8] Genome Comparison Dashboard     (already built!)      │
│                                                              │
│  PREDICTIONS                                                 │
│    [9] Host Range (CRISPR spacers)     (requires DB)         │
│    [0] AMG Pathway Mapper              (metabolic hijacking) │
│    [a] Promoter/RBS Strength           (expression levels)   │
│    [b] Prophage Excision Sites         (att site prediction) │
│    [c] Virion Stability                (therapy formulation) │
│                                                              │
│  WHOLE-GENOME VIEWS                                          │
│    [d] CGR Fractal Fingerprint         (full-screen)         │
│    [e] Hilbert Curve Atlas             (full-screen)         │
│    [f] Self-Homology Dot Plot          (full-screen)         │
│    [g] Tetranucleotide PCA             (full-screen)         │
│                                                              │
│  ─────────────────────────────────────────────────────────── │
│  [/] Search features...                                      │
╰─────────────────────────────────────────────────────────────╯
```

**Design principles:**
- **Categorized** — users find features by purpose, not alphabetically
- **Numbered shortcuts** — power users learn favorites (A + 5 = dN/dS)
- **Brief descriptions** — explain what each does in ≤4 words
- **Fuzzy search** — press `/` to filter by keyword
- **ESC always exits** — no trapped states

### Layer 3: The Simulation Hub (Press Shift+S)

Interactive simulations need their own space. They're time-evolving, may need parameter sliders, and fundamentally change the interaction model.

```
╭─────────────────────────────────────────────────────────────╮
│  SIMULATION HUB                                   [ESC] Exit │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  DYNAMIC SIMULATIONS                                         │
│                                                              │
│    [1] Lysogeny Decision Circuit                             │
│        Watch CI/Cro battle unfold — adjust MOI, UV damage    │
│        ════════════════════════════════════════════════════  │
│                                                              │
│    [2] Ribosome Traffic Simulator                            │
│        See translation bottlenecks form in real-time         │
│        ════════════════════════════════════════════════════  │
│                                                              │
│    [3] Plaque Growth Automata                                │
│        Cellular automaton of phage spreading on lawn         │
│        ════════════════════════════════════════════════════  │
│                                                              │
│    [4] Evolution Replay                                      │
│        Watch mutations accumulate across isolates            │
│        ════════════════════════════════════════════════════  │
│                                                              │
│    [5] Packaging Motor Pressure                              │
│        Feel the 60 atmospheres building in the capsid        │
│                                                              │
╰─────────────────────────────────────────────────────────────╯
```

**Design principles:**
- Dedicated space respects simulation complexity
- Each simulation has its own **full-screen mode** with custom controls
- Common controls: `Space` = pause/resume, `R` = reset, `←/→` = speed
- Status bar shows simulation time/state
- ESC returns to main view

### Layer 4: Command Palette (Press ':' or Ctrl+P)

For power users who know what they want, a **fuzzy-search command palette**:

```
╭─────────────────────────────────────────────────────────────╮
│  : gc skew█                                                  │
├─────────────────────────────────────────────────────────────┤
│  → GC Skew Origin Detector       Toggle overlay              │
│    Cumulative GC Skew Analysis   Full analysis view          │
│    GC Content in Comparison      Compare GC %                │
│                                                              │
│  [↑/↓] Navigate   [Enter] Select   [ESC] Cancel              │
╰─────────────────────────────────────────────────────────────╯
```

**Why command palette matters:**
- **Instant access** to any feature with 3-4 keystrokes
- **Discoverable** — users find features by typing concepts
- **Extensible** — future features automatically searchable
- Familiar to developers (VSCode, Sublime, Raycast)

---

## Feature Classification Table

| Feature | Layer | Access | Screen Impact |
|---------|-------|--------|---------------|
| GC Skew curve | L1 | `G` | Overlay |
| Complexity sparkline | L1 | `X` | Overlay |
| Bendability track | L1 | `B` | Overlay |
| Promoter annotations | L1 | `P` | Overlay |
| Repeat markers | L1 | `R` | Overlay |
| dN/dS painter | L2 | `A` → 5 | Overlay + panel |
| Structural variants | L2 | `A` → 6 | Overlay + panel |
| Synteny browser | L2 | `A` → 7 | Full-screen |
| Host range predictor | L2 | `A` → 9 | Panel |
| AMG mapper | L2 | `A` → 0 | Full-screen |
| CGR fractal | L2 | `A` → d | Full-screen |
| Hilbert curve | L2 | `A` → e | Full-screen |
| Dot plot | L2 | `A` → f | Full-screen |
| PCA plot | L2 | `A` → g | Full-screen |
| Lysogeny sim | L3 | `Shift+S` → 1 | Full-screen |
| Ribosome traffic | L3 | `Shift+S` → 2 | Full-screen |
| Plaque automata | L3 | `Shift+S` → 3 | Full-screen |
| Evolution replay | L3 | `Shift+S` → 4 | Full-screen |
| Packaging motor | L3 | `Shift+S` → 5 | Overlay + gauge |
| Virtual gel | L2 | `A` → ... | Panel |
| Sequence logo | L2 | `A` → 4 | Panel |
| (All features) | L4 | `:` | Search |

---

## Implementation Recommendations

### Phase 1: Foundation (Do First)

1. **Overlay System Architecture**
   - Create `OverlayManager` in state store
   - Define `Overlay` interface: `{ id, render, height, position }`
   - Implement overlay stacking logic (max 3 simultaneous?)
   - Add overlay status indicator to status bar

2. **Menu Infrastructure**
   - Create reusable `ModalMenu` component (Ink)
   - Define `MenuItem` interface with icons, shortcuts, actions
   - Implement keyboard navigation (↑/↓, numbers, letters)
   - Add fuzzy search capability

3. **Command Palette**
   - Create `CommandRegistry` singleton
   - All features register with name, keywords, action
   - Implement fuzzy matching (Fuse.js or simple scoring)
   - Hotkey: `:` or `Ctrl+P`

### Phase 2: Quick Overlays (High Impact, Low Effort)

These features benefit most from Layer 1 quick toggles:

| Overlay | Key | Data Source | Complexity |
|---------|-----|-------------|------------|
| GC Skew | `G` | Pure sequence | Low |
| Complexity | `X` | Compression | Low |
| Bendability | `B` | Dinucleotide tables | Medium |
| Promoter/RBS | `P` | Pattern match | Medium |

**Implementation pattern:**
```typescript
// In store
toggleOverlay: (id: OverlayId) => void;
activeOverlays: Set<OverlayId>;

// In component
const gcSkewData = useGCSkew(sequence); // Memoized
if (activeOverlays.has('gc-skew')) {
  return <OverlaySparkline data={gcSkewData} />;
}
```

### Phase 3: Analysis Menu

Create dedicated components for each analysis:

```
packages/tui/src/components/
  AnalysisMenu/
    index.tsx          # Menu modal
    categories.ts      # Category definitions
    items.ts           # MenuItem list
  Analysis/
    DNDSPainter.tsx
    StructuralVariants.tsx
    SyntenyBrowser.tsx
    CGRFractal.tsx
    HilbertAtlas.tsx
    DotPlot.tsx
    ...
```

### Phase 4: Simulation Hub

Simulations need special infrastructure:

```typescript
interface Simulation {
  id: string;
  name: string;
  description: string;

  // Lifecycle
  init: (params: SimParams) => SimState;
  step: (state: SimState, dt: number) => SimState;
  render: (state: SimState) => React.ReactNode;

  // Controls
  parameters: SimParameter[];
  controls: SimControl[];
}
```

Each simulation runs in a dedicated full-screen mode with:
- Parameter sliders (if applicable)
- Play/pause/speed controls
- Reset button
- Current state visualization
- ESC to exit

---

## Progressive Disclosure Strategy

**New User Journey:**

1. **First 5 minutes**: Navigate phages, scroll sequences, toggle DNA/AA view
   - Only Layer 0 needed
   - Help overlay shows only essential controls

2. **First hour**: Discover overlays via help, try diff mode, explore 3D model
   - Layer 0 + some Layer 1
   - Help now shows "Advanced: press A for more..."

3. **Power user**: Uses command palette, runs simulations, does comparative analysis
   - Full Layer 0-4 access
   - Discovers features through exploration

**Key insight**: Every feature should be **reachable in ≤3 keypresses** but **invisible until needed**.

---

## Help System Redesign

Current help is a single overlay. Proposed: **contextual, layered help**.

```
╭─────────────────────────────────────────────────────────────╮
│  HELP                                               [ESC]    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  NAVIGATION           │  VIEW CONTROLS                       │
│  ↑/↓  Select phage    │  N/C  DNA / Amino acid               │
│  ←/→  Scroll sequence │  F    Reading frame (1-3)            │
│  PgUp/PgDn  Page      │  T    Theme cycle                    │
│  Home/End   Jump      │  D    Diff mode                      │
│  [/]  Prev/next gene  │  M    3D model                       │
│                       │  K    Amino acid key                 │
│                       │                                      │
│  OVERLAYS (toggle)    │  SEARCH                              │
│  G  GC Skew           │  S or /  Search phages               │
│  X  Complexity        │                                      │
│  B  Bendability       │  ADVANCED                            │
│  P  Promoters         │  A       Analysis Menu               │
│  R  Repeats           │  Shift+S Simulation Hub              │
│                       │  :       Command Palette             │
│                       │                                      │
│  [?] Detailed docs    │  [Q] Quit                            │
╰─────────────────────────────────────────────────────────────╯
```

**Future enhancement**: Press `?` twice for detailed docs, including:
- Each overlay explained
- Each analysis tool described
- Keyboard shortcut cheatsheet

---

## Visual Language Guidelines

To maintain coherence across 31 features:

### Color Semantics
```
Green  (#22c55e)  = Good, conserved, stable, similar
Yellow (#eab308)  = Caution, moderate, neutral
Red    (#ef4444)  = Warning, divergent, unstable, different
Blue   (#3b82f6)  = Informational, cool metrics
Purple (#a855f7)  = Special, unique, notable
Gray   (#6b7280)  = Inactive, background, reference
```

### Graph/Sparkline Standards
```
Height: 3-5 character rows for overlays
Width:  Full terminal width
Scale:  Auto-normalize, show min/max in labels
Style:  Braille dots (⣿⣤⣀) for high resolution
```

### Panel/Modal Standards
```
Border: Single line box drawing (╭╮╰╯─│)
Header: Bold, centered, with close hint
Padding: 1 character on all sides
Max width: 80 characters (or terminal width - 4)
```

---

## State Management Considerations

```typescript
interface AdvancedUIState {
  // Overlay system
  activeOverlays: Set<OverlayId>;
  overlayConfigs: Map<OverlayId, OverlayConfig>;

  // Modal system
  activeModal: ModalId | null;
  modalHistory: ModalId[];  // For back navigation

  // Simulation state
  activeSimulation: SimulationId | null;
  simulationState: SimState | null;
  simulationSpeed: number;
  simulationPaused: boolean;

  // Command palette
  commandPaletteOpen: boolean;
  commandSearch: string;
  commandResults: CommandMatch[];
  selectedCommandIndex: number;

  // Computed data cache
  analysisCache: Map<string, AnalysisResult>;
}
```

Key principle: **Precompute on phage selection, not on feature activation.**

When user selects a phage, we should background-compute:
- GC skew curve
- Complexity profile
- Bendability track
- Promoter predictions

This makes overlays feel **instant** when toggled.

---

## Risk Mitigation

### Risk: Feature bloat slows down main loop
**Mitigation**:
- Lazy-load analysis components (`React.lazy`)
- Precompute in Web Worker / background
- Cache aggressively in SQLite

### Risk: Users get lost in menus
**Mitigation**:
- ESC always returns to main view
- Breadcrumb trail in status bar
- "Back" action in every modal

### Risk: Mobile/small terminal breaks
**Mitigation**:
- Detect terminal size, hide overlays if too small
- Stack overlays vertically if narrow
- Minimum viable mode: Layer 0 only

### Risk: Too many keybindings conflict
**Mitigation**:
- Layer 0 = unmodified lowercase letters
- Layer 1 = specific lowercase letters (G, X, B, P, R)
- Layer 2/3 = Shift+letter or menu selection
- Layer 4 = `:` prefix (command mode)

---

## Summary

The **Depth Layers** model preserves what makes Phage Explorer excellent while enabling 31 advanced features:

| Layer | Access | Audience | Features |
|-------|--------|----------|----------|
| L0 | Direct keys | Everyone | 12 core controls |
| L1 | Single keys | Intermediate | 5 quick overlays |
| L2 | `A` menu | Researchers | ~15 analyses |
| L3 | `Shift+S` menu | Explorers | 5 simulations |
| L4 | `:` palette | Power users | Everything |

**Total keystrokes to any feature**: 1-3
**Visible complexity for new users**: 12 controls
**Available power for experts**: 31+ features

The architecture is **extensible** — future features (32, 33, ...) simply register in the command palette and appear in the appropriate menu category.

---

*End of UI Architecture Recommendations*

---

# Ten New, Distinctive Advanced Ideas (Implementation-Focused)

The following ten are selected from a broader 100-idea sweep. They avoid overlap with earlier items and emphasize concrete build paths, novelty, pedagogy, and TUI “wow”.

## 1) Capsid Packaging & Ejection Energetics Simulator
- Concept: Quantify how tightly each genome is packed, how ionic conditions modulate repulsion, and how force decays during ejection. Shows why headful vs cos vs phi29 portals behave differently.
- Build plan: Rust core (ndarray + nalgebra) implementing worm-like chain + Debye–Hückel electrostatics; compile to WASM for Bun. Precompute force–extension and free-energy curves per phage length; cache to SQLite. Optional lookup table for known motors (T4, lambda, phi29) to benchmark.
- Why it’s good: Connects genome length/GC to physical viability; predicts ejection vigor and stability for therapy formulations.
- Novelty: Packaging physics almost never appears in TUIs; usually trapped in PDFs.
- Pedagogy: Polymer physics, electrostatics, and thermodynamics of viral machines.
- Wow/TUI: Interactive force–distance plot; scrubbing the genome drains an ASCII “unspooling” bar; pressure gauge flashes when over 50–60 atm.

## 2) Burst Kinetics & Latency Inference from Growth Curves
- Concept: Given OD/plaque time-series, infer latency, burst size, adsorption, and link back to holins/endolysins/antiholins in the genome.
- Build plan: Rust+WASM MAP fitter for ODE/SDE infection models (statrs + rayon); TS wrapper for data entry. Accept CSV/TSV timepoints; emit posterior bands and parameter covariances. Gene linking via annotation of lysis genes.
- Why it’s good: Bridges wet-lab curves to genome determinants; actionable for dosing and cocktail design.
- Novelty: Real-time kinetic inference inside a TUI genome tool is rare.
- Pedagogy: Likelihoods, parameter inference, model selection; shows how genes map to kinetics.
- Wow/TUI: Live curve fit with shaded posteriors; when burst size is high the lysis gene bar glows; toggle between deterministic vs stochastic fits.

## 3) Lysogeny/Lysis Decision Circuit Reconstructor
- Concept: Recover the regulatory switch (promoters, operators, terminators, CI/Cro-like repressors) and simulate bistable decisions under MOI/stress.
- Build plan: Motif scans (promoter/terminator/operator) in TS; CI/Cro clustering via HMMER. Boolean simulator in TS; ODE simulator in Rust+WASM for smooth trajectories. Inputs: MOI, DNA damage, inducer; outputs: Cro/CI levels over time.
- Why it’s good: Explains why a phage goes lytic vs lysogenic; aids engineering of strictly lytic variants.
- Novelty: Interactive switch tied to predicted regulatory sites in a TUI is novel.
- Pedagogy: Bistability, feedback loops, Hill kinetics, and promoter/operator logic.
- Wow/TUI: ASCII phase portrait (CI vs Cro) that “snaps” to attractors; promoter/operator map lights as states change; sliders for MOI/stress flip the state live.

## 4) Host–Phage Protein Interaction & Effector Docking Map
- Concept: Predict which host proteins are targeted by phage effectors (anti-defense, tail fibers vs receptors).
- Build plan: Protein LM embeddings (ESM) for fast similarity in TS; optional coarse docking via pydock3/lightdock batched in Rust workers, cached to disk. Domain heuristics (PFAM/HHPred) refine candidates. Confidence scoring fused from embedding cosine + docking rank + domain compatibility.
- Why it’s good: Surfaces mechanistic host-range and anti-defense hypotheses beyond BLAST.
- Novelty: Docking hints and interaction wiring inside a terminal browser are rare.
- Pedagogy: Embedding similarity, structural docking, domain-function mapping.
- Wow/TUI: Bipartite “wiring” view—phage proteins left, host targets right; edge thickness = confidence; hover shows docking score and key residues; hit `f` to filter by function (receptor, defense, metabolism).

## 5) Metagenomic Co-Occurrence & Ecological Niche Profiler
- Concept: Use metagenomic abundance tables to infer where a phage lives and with whom; derive latent “niche vectors.”
- Build plan: Ingest TSV/BIOM; compute compositional correlations (SparCC/FlashWeave-like) in Rust → WASM; NMF/PMF factorization in TS to get niche loadings; link to habitat/host metadata. Cache niche vectors with phage.
- Why it’s good: Complements CRISPR/prophage host signals with evidence from the wild.
- Novelty: Real-time niche inference + co-occurrence graphing in a TUI is uncommon.
- Pedagogy: Compositional stats, network inference, niche ecology, correlation vs causation.
- Wow/TUI: Co-occurrence graph colored by niches; press `n` to repaint the phage’s niche as a stacked bar; tooltips show top co-occurring taxa and habitats.

## 6) Auxiliary Metabolic Gene (AMG) Flux Potential Analyzer
- Concept: Find AMGs and estimate how much they can shift host metabolic flux (e.g., nucleotide salvage, photosystem boost).
- Build plan: HMMER vs curated AMG sets; map hits to KEGG reactions; lightweight delta-FBA (TS linear algebra or Rust+good_lp) to estimate flux gain when AMG is “on.” Store per-pathway Δflux.
- Why it’s good: Turns annotations into quantitative metabolic impact; highlights phage metabolic hijacking.
- Novelty: AMG + flux estimation inline in a TUI is unusual.
- Pedagogy: Metabolic control analysis, stoichiometry, why AMGs matter.
- Wow/TUI: AMG list with “expected flux gain” badges; sparkline of boosted reactions; toggle host contexts to see deltas change.

## 7) Prophage Integration Site & Excision Risk Explorer
- Concept: Predict attB hot spots, integrase class, and how stable the prophage will be; simulate excision likelihood.
- Build plan: Motif scan for attB/tRNA/tmRNA hotspots; integrase typing via HMM (tyrosine/serine); recombination simulator (exact + mismatch penalties) in TS/Rust; compute symmetry/repeat-driven excision risk. Cache site likelihoods along the genome.
- Why it’s good: Guides safe insertion sites and expectations for stability or escape.
- Novelty: att heatmaps + excision risk curves in a TUI are rare.
- Pedagogy: Site-specific recombination, repeats, genome stability.
- Wow/TUI: Genome ribbon with colored att likelihood; toggle “simulate integration” to see pre/post maps; excision risk meter updates as you choose sites.

## 8) Periodicity & Tandem Repeat Wavelet Spectrogram
- Concept: Reveal tandem repeats, packaging signals, or promoter periodicities using spectral methods (CWT/FFT).
- Build plan: CWT in Rust (realfft + wavelet) → WASM; FFT fallback in TS for short genomes. Extract dominant periods and phases; tag repeat families and packaging motif candidates. Cache spectrogram slices.
- Why it’s good: Finds periodic signals missed by simple motif scans; links to packaging and regulation.
- Novelty: Wavelet spectrograms in a TUI genome browser are highly unusual.
- Pedagogy: Spectral analysis, periodicity detection, signal-to-biology mapping.
- Wow/TUI: Braille spectrogram strip under the sequence grid; cursor shows dominant period and phase; press `p` to jump to strongest repeat block.

## 9) Epistasis & Fitness Landscape Explorer (In Silico DMS)
- Concept: Estimate how combinations of mutations interact (epistasis) on capsid/tail/polymerase to reveal robust vs fragile regions.
- Build plan: Single-mutant scores from protein LMs (ESM); pairwise epistasis via Potts/EVcouplings-like models fit in Rust (statrs + ndarray) → WASM; sample top combinations; optional integration of sparse experimental DMS. Cache Δfitness matrices.
- Why it’s good: Anticipates escape routes and designable stable regions.
- Novelty: Epistasis maps in a terminal for phage proteins are rare.
- Pedagogy: Fitness landscapes, epistasis, mutational robustness/fragility.
- Wow/TUI: 2D heatmap (pos×pos) with hotspots; select a cell to see Δfitness and example double-mutant; slider to switch proteins.

## 10) Cocktail Resistance Evolution Simulator
- Concept: Simulate how resistance emerges against a phage cocktail under different MOI/regimens, parameterized by genome features (receptor diversity, anti-defense, spacer proximity).
- Build plan: Gillespie/tau-leaping in Rust (rand + rayon) → WASM; parameters pulled from genome annotations; run many trajectories to estimate resistance probability over time. TS UI for sliders (MOI, dosing interval, population size).
- Why it’s good: Turns genomic evidence into concrete therapy risk estimates and dosing guidance.
- Novelty: Cocktail-focused evolutionary simulation inside a TUI is unusual.
- Pedagogy: Stochastic processes, evolutionary dynamics, and intervention design.
- Wow/TUI: Live ASCII time-series with multiple trajectories; “risk meter” updates in real time; toggle to compare single-phage vs cocktail curves side-by-side.

---

## 11) Latent Genome Fingerprints (LGFs) via Contrastive Encoders
- Concept: Learn fixed-length embeddings for phage genomes that capture composition, motifs, and structural signals; explore a “phage universe” to find nearest neighbors and hidden clusters beyond ANI/k-mers.
- Build plan: Train/finetune a contrastive encoder (BYOL/SimCLR-style) on large phage + host-viral corpora. Core in Python (PyTorch + bitsandbytes), export encoder to ONNX; run inference in Bun via ONNX Runtime Web or WASM. Precompute embeddings for bundled phages and cache to SQLite. Use UMAP/TSNE (Rust + WASM via `umap-js`/`tsne-rs`) for on-device projection.
- Why it’s good: Captures higher-order signals (motif co-occurrence, periodicity, codon bias) into a single vector; enables fast “find me things like this” beyond simple k-mer overlap.
- Novelty: Genome embeddings in a TUI with real-time nearest-neighbor search are rare; most tools stop at ANI or Mash.
- Pedagogy: Teaches representation learning and why distance metrics differ; shows latent space vs classic metrics.
- Wow/TUI: Interactive 2D “phage universe” scatter with density shading; keyboard to jump to nearest neighbors; hover tooltips show phage meta; pressing `l` recenters on the current phage and animates a zoom.

## 12) Pan-Genome Graph & Variant Hotspot Explorer
- Concept: Build a pan-genome graph for related phages; spotlight structural variants, accessory gene bubbles, and recombination corridors.
- Build plan: Construct variation graph with `vg`/`odgi` pipeline offline; slim graph to JSON/flatbuffer. At runtime, traverse graph slices in Rust (petgraph) → WASM. Overlay breakpoint density and accessory gene frequency; store tiles in SQLite for rapid paging.
- Why it’s good: Shows mosaicism and accessory gene flow, not just linear alignments; reveals conserved backbone vs highly exchanged islands.
- Novelty: Pan-genome graph visualized in a TUI genome browser is uncommon; most stay in web notebooks.
- Pedagogy: Introduces graph genomes, bubbles, and paths; clarifies why linear references miss diversity.
- Wow/TUI: ASCII path stack with bubbles drawn as branches; hotspot heat band under the sequence grid; pressing `g` toggles “graph mode” where cursor walks along the primary path and shows alternate alleles.

## 13) Codon–tRNA Adaptation Radar vs Host Panels
- Concept: Compare a phage’s codon usage against multiple host tRNA repertoires to quantify translational adaptation or host-jump potential.
- Build plan: Precompute CAI/tAI/CUB per host using host tRNA gene sets (imported TSV/FASTA). Compute per-gene and genome-level scores in Rust (ndarray) → WASM; cache per-host radar values. Optional ML regressor to predict burst efficiency from adaptation scores.
- Why it’s good: Connects codon bias to real host compatibility; highlights phages poised to infect alternative hosts.
- Novelty: Multi-host tRNA adaptation dashboards are rare in terminal tools.
- Pedagogy: Explains codon bias, tRNA availability, and translational control.
- Wow/TUI: Radar chart (braille blocks) of hosts vs adaptation; pressing `h` cycles hosts; genes list sorted by adaptation delta; inline badges for over-/under-adapted modules.

## 14) Synonymous Landscape & RNA Structure Stress Map
- Concept: Map how synonymous changes would alter mRNA folding/ΔG along coding regions to flag structure-constrained segments.
- Build plan: Use ViennaRNA (via `viennarna-wasm`) for sliding-window MFE/ΔG; compute “synonymous stress” by sampling silent variants in Rust → WASM to estimate ΔΔG distribution. Annotate high-stress windows and link to translation attenuation or regulatory RNA hypotheses.
- Why it’s good: Finds regions constrained by RNA structure, not just protein sequence; informs safe recoding and understanding of attenuation.
- Novelty: Synonymous ΔΔG stress maps inside a TUI genome explorer are rare.
- Pedagogy: Shows interplay of codon choice, RNA structure, and translation kinetics.
- Wow/TUI: Heat strip under the gene showing ΔG and “stress” percentile; cursor shows example synonymous change and predicted ΔΔG; toggle to overlay on sequence grid.

## 15) Tail Fiber Tropism & Receptor Atlas
- Concept: Predict receptor-binding specificity by clustering tail fiber/tip proteins and mapping them to known or candidate host receptors.
- Build plan: Embed tail fibers with ESM/ProtT5 (Python), cluster with HDBSCAN/UMAP; optional AlphaFold2-lite batches for 3D hints; match against receptor HMMs and host surface proteomes. Cache clusters and receptor likelihoods; inference via ONNX Runtime in Bun for new sequences.
- Why it’s good: Sharpens host-range hypotheses and engineering targets; complements codon/tRNA signals.
- Novelty: Dedicated tail-fiber tropism mapping in a TUI is uncommon; prior idea #4 focused on broad PPI/docking, this centers on receptor-binding lineage and host-range.
- Pedagogy: Demonstrates embeddings, clustering, and receptor inference; links sequence to phenotype.
- Wow/TUI: “Tropism map” with clusters as colored nodes; select a node to see top receptor candidates and host taxa; quick badge for predicted host-range breadth.

## 16) Recombination Mosaic & Ancestry Heatmap
- Concept: Detect mosaic ancestry along the genome using change-point detection on k-mer/embedding profiles and local phylogenies.
- Build plan: Segment with ruptures-like change-point (Rust + ndarray) on embedding/k-mer vectors; for each segment, compute nearest clade via sketch (Mash/MinHash) and mini-tree (fast neighbor-joining). Cache segment→clade calls. WASM for change-point + sketching; small phylo in TS for speed.
- Why it’s good: Reveals chimeric origins and recent recombination donors; useful for surveillance and design.
- Novelty: Inline ancestry-by-segment in a TUI genome browser is rare.
- Pedagogy: Teaches recombination, mosaicism, and local phylogeny concepts.
- Wow/TUI: Genome heat strip with colors per donor clade; cursor shows donor list and support; press `r` to highlight high-confidence recombination breakpoints.

## 17) Arms-Race Timeline: CRISPR/RM/Abi vs Anti-Defense
- Concept: Integrate host defense genes (CRISPR arrays, RM, Abi) with phage anti-defense (anti-CRISPRs, Ocr-like, anti-RM) to visualize escalation.
- Build plan: Parse host defenses from provided host genomes/metadata; scan phages for anti-defense HMMs (AcrDB, Ocr-like) and methyltransferases. Score matches (phage defense vs host counter-defense). Store pairs in SQLite. Light inference in TS; heavy HMM in Rust+WASM.
- Why it’s good: Connects genomic arms-race signals to practical host-range and durability.
- Novelty: Defense/counter-defense wiring shown live in TUI is uncommon.
- Pedagogy: Illustrates coevolutionary pressure and molecular fencing.
- Wow/TUI: Bipartite defense map with “who counters what”; timeline bar if isolation dates known; meter indicating “defense pressure” vs “counter strength.”

## 18) Environmental & Geospatial Provenance Map
- Concept: Map each phage to nearest metagenomic hits across biomes/locations to infer habitat and novelty.
- Build plan: Import sketch indexes (Mash/FracMinHash) of public metagenomes (IMG/VIROME, MGnify) prebuilt offline; at runtime, query sketches in Rust → WASM. Store top hits with biome/geo metadata in SQLite. Compute novelty score (1 - max containment).
- Why it’s good: Adds ecological context and highlights novel clades or constrained niches.
- Novelty: Geospatial/biome linkage in a TUI phage browser is rare.
- Pedagogy: Shows metagenomic surveillance, containment vs identity, and biome diversity.
- Wow/TUI: Mini world/biome map with hit density; novelty badge; press `e` to cycle habitats and see containment bars.

## 19) Capsid Thermal/Ionic Stability & Storage Advisor
- Concept: Predict capsid stability across temperature and ionic strength for handling/formulation guidance.
- Build plan: Use empirical models + coarse-grain capsid energetics (Rust + nalgebra) estimating melting/denaturation thresholds from capsid protein composition, salt bridges, and charge. Optional lightweight MD-informed parameters. Precompute stability curves; WASM for quick recalcs when conditions slide.
- Why it’s good: Practical guidance for storage/shipping; connects sequence to physical robustness.
- Novelty: Thermal/ionic robustness predictions in a TUI genome explorer are uncommon.
- Pedagogy: Links protein chemistry (charge, hydrophobics) to macroscopic stability.
- Wow/TUI: “Stability bar” that shifts as you adjust temperature/salt sliders; warning icon when outside safe envelope; ASCII melting curve plot.

## 20) Transcription Flow & Promoter Strength Explorer
- Concept: Predict promoter/terminator strengths and simulate transcriptional flow to identify bottlenecks or overexpression risks.
- Build plan: Promoter/terminator scoring via motif/HMM + CNN-lite (ONNX in Bun). Use a simple queue/flow model in TS or Rust+WASM to propagate polymerase flux, considering pauses and terminators. Link to gene functions to flag likely expression imbalances.
- Why it’s good: Bridges sequence-level regulatory signals to expression realism; aids redesign.
- Novelty: Live transcription flow simulation in a TUI genome browser is rare.
- Pedagogy: Shows promoter strength, termination efficiency, and transcriptional bottlenecks.
- Wow/TUI: “Flow meter” overlay with thickness proportional to predicted transcription; paused regions glow; toggling σ-factor presets redraws the map live.

---

# Detailed Expansions (matching full-format ideas)

## 32) Capsid Packaging & Ejection Energetics Simulator

### Concept
Quantify the physics of packing dsDNA into a confined capsid and its subsequent ejection. Model force–extension, internal pressure (up to ~60 atm), salt/GC effects, and differences among headful vs cos vs phi29 portal strategies.

### How to Build
- **Physics core (Rust+WASM)**: Worm-Like Chain elasticity + Debye–Hückel electrostatics + bending energy; ndarray + nalgebra; compile to WASM for Bun.
- **Precompute per phage**: Given genome length, GC%, capsid radius, portal type → force/energy curves; cache in SQLite (dense arrays serialized).
- **Motor benchmarks**: Table of ATP/bp and stall forces for T4, lambda, phi29 for comparison overlays.
- **Controls**: Sliders for ionic strength (Na+/Mg2+), temperature; toggle headful/cos; “fill fraction” scrubber animates packing/ejection.

### Why It’s Good
Links genome composition to biophysical feasibility and ejection vigor—useful for stability, storage, and therapeutic formulation.

### Novelty
High. Packaging thermodynamics is almost never interactive; typically buried in PDFs or static plots.

### Pedagogical Value
Teaches polymer physics, electrostatics, and molecular machines; shows why “longer genome” has real energetic costs.

### Wow / TUI Visualization
ASCII force–distance plot; live pressure gauge flashing at high fill; “unspooling” animation on ejection; overlay motor benchmarks as dashed curves.

### Implementation Stack
Rust+WASM physics; TS/Bun UI; SQLite cache; minimal deps beyond ndarray/nalgebra/statrs.

---

## 33) Burst Kinetics & Latency Inference from Growth Curves

### Concept
Infer adsorption, latent period, and burst size from OD/plaque time-series and map back to holin/endolysin/antiholin loci.

### How to Build
- **Model**: Classic infection ODE/SDE (SIR-like with adsorption, latent, burst).
- **Inference (Rust+WASM)**: MAP/bootstrapped fits using statrs + rayon; bounded parameters; supports deterministic and tau-leaping stochastic modes.
- **Data ingest**: CSV/TSV via d3-dsv or native parser; unit normalization.
- **Genome link**: Annotate lysis cassette; display inferred latency/burst alongside gene positions.
- **UI**: Live fit plot with credible bands; toggle deterministic/stochastic; residuals pane.

### Why It’s Good
Turns wet-lab curves into actionable genome-linked parameters; informs dosing and cocktail design.

### Novelty
High—real-time kinetic fitting inside a TUI genome browser is rare.

### Pedagogical Value
Shows likelihoods, uncertainty, and gene-to-phenotype links; demonstrates why holin variants shift burst timing.

### Wow / TUI Visualization
Animated fit with shaded CI; lysis genes glow proportional to burst size; slider scrubs time to show phase (adsorption/latent/lysis).

### Implementation Stack
Rust+WASM fitting; TS charts; SQLite cache of parameter posteriors; no heavy ML deps.

---

## 34) Lysogeny/Lysis Decision Circuit Reconstructor

### Concept
Rebuild the CI/Cro-like regulatory switch from sequence motifs and simulate bistable decisions under varying MOI/damage.

### How to Build
- **Motifs**: Promoter/operator/terminator scans in TS; HMMER for CI/Cro-family clustering (precompute).
- **Simulation**: Boolean fast mode in TS; ODE/Hill kinetics in Rust+WASM for smooth trajectories; parameters from motif strengths.
- **Inputs**: MOI, UV/damage, inducer; outputs: CI/Cro trajectories, final state.
- **Overlay**: Operators/promoters highlighted on genome; active elements blink during sim.

### Why It’s Good
Explains lytic vs lysogenic outcomes; aids design of strictly lytic derivatives.

### Novelty
High—interactive regulatory switch tied to predicted sites in-terminal is new.

### Pedagogical Value
Bistability, Hill coefficients, feedback loops, and the role of operator spacing.

### Wow / TUI Visualization
ASCII phase portrait (CI vs Cro) with attractors; sliders flip basins; promoter/operator bars animate as state flips.

### Implementation Stack
Rust+WASM ODE core; TS UI; HMMER precompute cached in SQLite; lightweight, no GPU.

---

## 35) Host–Phage Protein Interaction & Effector Docking Map

### Concept
Predict host targets of phage effectors (anti-defense, RBPs) by fusing embeddings, domains, and optional docking.

### How to Build
- **Embeddings**: Precompute ESM/ProtT5 vectors offline; store in SQLite as float32 blobs.
- **Search**: Cosine ANN (Rust+WASM or TS) to shortlist host targets.
- **Domains**: PFAM/HHPred annotations to filter plausible interactions.
- **Docking (optional)**: Coarse rigid docking via lightdock/pydock3 offline; store top ranks.
- **Scoring**: Fuse embedding sim + docking + domain compatibility → confidence.
- **UI**: Bipartite graph; edges encode confidence; tooltips show docking score, residues; filters for receptor/defense/metabolism.

### Why It’s Good
Generates mechanistic host-range and anti-defense hypotheses beyond BLAST.

### Novelty
High—interaction wiring + docking hints in a TUI is rare.

### Pedagogical Value
Embeddings, docking, domain-function mapping; shows limits of sequence identity.

### Wow / TUI Visualization
Interactive “wiring” board; hover to see residues/contact score; hit `f` to filter by functional class.

### Implementation Stack
Offline Python for embeddings/docking; SQLite cache; Rust+WASM or TS ANN; TS/Ink UI.

---

## 36) Metagenomic Co-Occurrence & Ecological Niche Profiler

### Concept
Infer ecological niches and co-occurring taxa from metagenomic abundance tables; derive niche vectors and networks.

### How to Build
- **Input**: BIOM/TSV + sample metadata.
- **Correlations**: SparCC/FlashWeave-like compositional inference in Rust+WASM (ndarray + rayon).
- **Niche factors**: NMF/PMF in TS for latent “niche vectors”.
- **Metadata mapping**: Attach habitats/hosts to factors; cache per phage.
- **UI**: Co-occurrence network colored by niches; stacked niche bars per phage; filters by habitat.

### Why It’s Good
Adds real-world context to host predictions; complements CRISPR/prophage evidence.

### Novelty
Medium-high—niche graphs inside a genome TUI are uncommon.

### Pedagogical Value
Compositional stats, correlation vs causation, niche ecology.

### Wow / TUI Visualization
Network with niche colors; press `n` to repaint bars; tooltips show top co-occurring taxa/habitats; toggle significance threshold live.

### Implementation Stack
Rust+WASM for correlations; TS NMF; SQLite cache of niche vectors; BIOM parser in TS.

---

## 37) Auxiliary Metabolic Gene (AMG) Flux Potential Analyzer

### Concept
Detect AMGs, map to KEGG reactions, and estimate pathway flux gains in target hosts.

### How to Build
- **Detection**: HMMER vs curated AMG profiles (offline); KO mapping cached.
- **Flux**: Delta-FBA: small LP solved in TS (simple solver) or Rust+WASM (good_lp) for speed.
- **Hosts**: Template models for common hosts; map AMGs to reactions; recompute objective (ATP/dNTP).
- **Outputs**: Δflux per pathway; confidence from KO scores; highlight biggest boosts.

### Why It’s Good
Turns annotations into quantitative metabolic impact; surfaces hijacking strategies.

### Novelty
Medium-high—AMG + flux in a TUI is unusual.

### Pedagogical Value
Stoichiometry, metabolic control, AMG role in ecology.

### Wow / TUI Visualization
Pathway mini-map with AMG nodes glowing; “flux gain” badges; host-switch toggle to watch deltas change.

### Implementation Stack
Offline HMMER; Rust+WASM or TS LP; SQLite cache; TS/Ink UI.

---

## 38) Prophage Integration Site & Excision Risk Explorer

### Concept
Score attB hot spots, classify integrases, and estimate excision precision/risk; simulate integration/excision.

### How to Build
- **Integrase typing**: HMMER classify tyrosine/serine integrases (offline).
- **att search**: DR/imperfect repeat scan near tRNA/tmRNA; TS or Rust+WASM for speed.
- **Risk scoring**: Symmetry/mismatch penalties; recombination likelihood; store per-window scores.
- **UI**: Genome heatmap of att likelihood; pick a site to see attL/attR/attP/attB reconstruction and risk meter.

### Why It’s Good
Guides safe integration; anticipates prophage stability/escape.

### Novelty
Medium-high—att likelihood + risk visualization in-terminal is rare.

### Pedagogical Value
Recombination fundamentals, repeats, genome stability.

### Wow / TUI Visualization
Heatmapped genome bar; click peak to animate integration/excision; risk meter updates live.

### Implementation Stack
TS for scan; optional Rust+WASM repeat finder; SQLite cache for integrase classes/scores.

---

## 39) Periodicity & Tandem Repeat Wavelet Spectrogram

### Concept
Detect tandem repeats, packaging motifs, and promoter periodicities via wavelets/FFT.

### How to Build
- **Spectral core**: CWT in Rust+WASM (realfft + wavelet kernel); FFT fallback in TS for short genomes.
- **Peak picking**: Dominant periods/phases; tag repeats/pack motifs.
- **Caching**: Store spectrogram slices per phage in SQLite.
- **UI**: Braille spectrogram under sequence grid; cursor shows dominant period/phase; jump-to-peak hotkey.

### Why It’s Good
Finds periodic signals missed by motifs; links to packaging/regulation.

### Novelty
High—wavelet spectrogram in a TUI genome browser is highly unusual.

### Pedagogical Value
Spectral analysis, periodicity, signal-to-biology mapping.

### Wow / TUI Visualization
Scrolling spectrogram; highlight strongest bands; “period” badge updates as you move.

### Implementation Stack
Rust+WASM for speed; TS UI; SQLite cache.

---

## 40) Epistasis & Fitness Landscape Explorer (In Silico DMS)

### Concept
Map pairwise epistasis for key proteins (capsid/tail/polymerase) to find robust vs fragile regions and likely escape routes.

### How to Build
- **Singles**: LM-based single-mutant scores (ESM) precomputed offline.
- **Pairs**: Potts/EVcouplings-like model fit in Rust+WASM (ndarray + statrs); sample top ΔΔ fitness pairs.
- **Optional**: Ingest sparse experimental DMS to refine weights.
- **UI**: Braille heatmap (pos×pos); select cell to view Δfitness, example mutants, structural note; protein selector.

### Why It’s Good
Anticipates escape; guides stable engineering targets.

### Novelty
High—epistasis maps for phage proteins in-terminal are rare.

### Pedagogical Value
Fitness landscapes, epistasis, robustness/fragility concepts.

### Wow / TUI Visualization
Heatmap with hotspot callouts; “mutant card” popup; slider to threshold significance.

### Implementation Stack
Offline LM scoring; Rust+WASM Potts; SQLite matrix cache; TS UI.

---

## 41) Cocktail Resistance Evolution Simulator

### Concept
Simulate resistance emergence under single vs cocktail regimens using genome-derived parameters (receptor diversity, anti-defense, spacer proximity).

### How to Build
- **Engine**: Gillespie/tau-leaping in Rust+WASM (rand + rayon).
- **Params**: Pull receptor diversity, Sie genes, CRISPR spacer matches from genome; user sets MOI, dosing cadence, population size.
- **Outputs**: Probability of resistance over time; time-to-resistance distribution; compare mono vs cocktail.
- **UI**: Live ASCII trajectories; risk meter; side-by-side mono vs cocktail view; sliders for MOI/dose interval.

### Why It’s Good
Turns genomic evidence into dosing/risk guidance; compares mono vs cocktail robustness.

### Novelty
High—cocktail-focused evolutionary sim in a TUI is uncommon.

### Pedagogical Value
Stochastic processes, evolutionary dynamics, intervention strategy.

### Wow / TUI Visualization
Multiple live trajectories; risk meter updates; toggle “optimize cocktail” to pick best trio and re-run.

### Implementation Stack
Rust+WASM simulator; TS/Ink UI; SQLite cache for genome-derived parameters.

---

## 35) Pan-Phage Graph Pangenome & Structural Variant Cards

### Concept
Build a graph pangenome over all bundled phages (plus fetched neighbors) to expose conserved cores, accessory modules, recombination breakpoints, and mosaicism. Let users “open a card” per variant to see the local diff, donor lineage hints, and functional impact.

### How to Build
- **Graph construction**: Rust (petgraph + rayon) to create an rGFA-like graph; align genomes with minimap2 bindings or rust-bio’s aligners; compress bubbles into variant records (SNP/indel/structural).
- **Annotation linkage**: Map genes, AMGs, defense/anti-defense loci onto graph nodes; tag breakpoints.
- **Variant cards**: Store per-bubble metadata in SQLite (size, gene overlap, GC shift, donor similarity).
- **Query**: WASM-compiled graph summaries; TS-layer renders “variant card” views and filters (size, function, donor).

### Why It’s Good
Shows modular mosaicism and reassortment—the real evolutionary story—not just linear diffs. Surfaces hotspots that matter for host range or defense evasion.

### Novelty
Graph pangenomes are common in research papers, almost never interactive in a TUI with per-variant drilldown.

### Pedagogical Value
Teaches pangenome graphs, bubbles, core vs accessory genomes, and how recombination shapes phages.

### Wow / TUI Visualization
Mini ASCII graph ribbon with bubbles highlighted; press enter to pop a “variant card” showing diff stats, donor lineage bar, and overlapped genes; jump the sequence grid to the variant locus.

### Implementation Stack
Rust+WASM graph builder (petgraph, rust-bio); minimap2 binding for alignments; SQLite for cards; TS/Ink UI for cards and bubble strips.

---

## 36) Latent Embedding Atlas (Genome + Proteome, LLM-Augmented)

### Concept
Learn joint embeddings for genomes and proteomes using k-mer sketches plus protein language-model embeddings (ESM/ProtT5). Cluster phages by functional/evolutionary proximity; explain cluster membership with “semantic diffs.”

### How to Build
- **Embeddings**: TS pipeline for k-mer MinHash sketches; Python/Rust sidecar (optional) to batch ESM2/ProtT5 embeddings for key proteins (tail fibers, polymerases, repressors). Cache vectors in SQLite/Parquet.
- **Fusion**: Concatenate or project via PCA/UMAP (Rust+WASM or TS with ml-js) into 2D/3D; store neighbor indices (FAISS-like HNSW via wasm-hnsw or a Rust HNSW).
- **Explanations**: For a neighbor pair, surface top k-mer deltas, domain differences, and codon/AA usage deltas.

### Why It’s Good
Gives a “map” of phage space that blends sequence and functional signals; fast neighbor lookup; highlights outliers and novelty.

### Novelty
Embedding atlases exist for proteins, rarely for whole phages combining genome + key proteins inside a TUI.

### Pedagogical Value
Shows representation learning, manifold structure, and how different molecular layers agree or disagree.

### Wow / TUI Visualization
ASCII UMAP scatterplot with live cursor; select a point to list nearest neighbors and “why” (top domains/k-mers); glow outliers; toggle layers (genome-only vs protein-LLM fused).

### Implementation Stack
MinHash in TS; embeddings via optional Python microservice (ESM2) cached to disk; HNSW in Rust+WASM; UMAP in Rust (umap-rs) or TS (umap-js) for projection; Ink UI.

---

## 37) Host-Range Inference via CRISPR Spacers + Receptor Motifs

### Concept
Fuse CRISPR spacer hits with receptor-binding motif classifiers to predict host range. Score per host lineage and display evidence (spacer alignments, motif hits on tail fibers/RBPs).

### How to Build
- **Spacer DB ingest**: Parse spacer FASTAs/TSVs; build MinHash/LSH index (Rust+WASM) for fast lookup; fall back to banded alignments for top hits.
- **Motif/RBP typing**: HMMER precompute for RBP families; TS classifier on receptor-binding motifs (e.g., beta-helix, depolymerase signatures).
- **Fusion scoring**: Bayesian or weighted fusion of spacer evidence + motif likelihood; cache per host taxon.
- **UI**: Evidence table per host; toggle “strict vs permissive” thresholds.

### Why It’s Good
Host prediction is often weak; combining CRISPR evidence with RBP motifs tightens calls and points to mechanisms.

### Novelty
Spacer-only predictors exist; fused spacer+motif scoring in-terminal with evidence drilldown is uncommon.

### Pedagogical Value
Shows complementary evidence types, false positives/negatives, and why motifs matter beyond sequence homology.

### Wow / TUI Visualization
Host leaderboard with confidence bars; press a host to see spacer hit list and RBP motif hits; “host cloud” ASCII plot sized by probability.

### Implementation Stack
Rust+WASM LSH for spacers; HMMER precompute for RBP domains; fusion/scoring in TS; SQLite cache; Ink UI tables/plots.

---

## 38) Codon/AA Adaptation Landscape with Host tRNA Supply

### Concept
Model how well each phage is adapted to different hosts’ tRNA pools. Compute RSCU/CAI against host-specific tRNA atlases and show adaptation gradients across the genome.

### How to Build
- **tRNA atlas ingest**: Import per-host tRNA copy numbers/anticodon pools (TS ETL).
- **Metrics**: RSCU, CAI, and tAI per phage gene; sliding-window adaptation scores; Rust+WASM for speed if needed.
- **Comparisons**: Delta adaptation between two hosts; flag regions with poor match.
- **UI**: Per-gene bars colored by adaptation; switch host profile live.

### Why It’s Good
Connects translational efficiency to host preference; highlights adaptation mismatches and imported islands.

### Novelty
CAI/tAI are classic, but interactive host-switching adaptation maps in a TUI are rare.

### Pedagogical Value
Teaches codon bias, tRNA availability, and translational selection; shows why context matters.

### Wow / TUI Visualization
Gradient bar along genome; hover shows gene CAI/tAI for selected host; side-by-side host A vs host B adaptation strips.

### Implementation Stack
TS for metrics; optional Rust+WASM for sliding windows; SQLite cache of host tRNA pools and per-gene scores; Ink UI with stacked bars.

---

## 39) Recombination & Mosaicism Radar (Sliding-Window Phylo)

### Concept
Detect recombination breakpoints and donor lineages with bootscan-like sliding-window phylogenetics and similarity spectra.

### How to Build
- **Windows**: Slice genome; compute k-mer Jaccard/Mash distances to a panel; optional fast neighbor-joining per window (Rust+WASM).
- **Breakpoint calling**: Change-point detection (PELT/Bayesian) on similarity traces; store segments with top donors.
- **Donor hints**: Track which reference best matches each window; summarize donor composition.
- **UI**: Radar or ribbon showing donor colors per window; breakpoint markers.

### Why It’s Good
Highlights mosaic origins and reassortment that explain phenotypes (host range, defense genes).

### Novelty
Bootscan tools exist but not integrated, interactive, and donor-colored inside a TUI genome grid.

### Pedagogical Value
Explains recombination detection, window trade-offs, and donor inference.

### Wow / TUI Visualization
Circular radar with colored arcs; move cursor to see donor and similarity; press `b` to jump to breakpoints; sparkline of similarity underneath.

### Implementation Stack
Rust+WASM for windowed k-mer distances and neighbor-joining; change-point in Rust (statrs) or TS; SQLite to cache window summaries; Ink radar/ribbon render.

---

## 40) Protein Structure Quickview via Fold Embeddings

### Concept
Cluster key structural proteins (capsid, tail fibers, portal, polymerase) using structure-aware embeddings to spot fold-family jumps and receptor-binding innovations.

### How to Build
- **Embeddings**: TM-Vec/ESMFold distogram embeddings (precompute via Python sidecar); cache vectors.
- **Clustering**: HNSW/UMAP pipeline (Rust+WASM) for nearest neighbors; novelty score vs known folds.
- **Delta explainer**: Highlight domain swaps, loop insertions, and charge patches.
- **UI**: Pick a protein, see its nearest fold neighbors, novelty score, and an ASCII “contact map strip.”

### Why It’s Good
Captures structural novelty beyond sequence identity; surfaces RBP innovations driving host jumps.

### Novelty
Structure embedding clustering inside a TUI genome browser is rare.

### Pedagogical Value
Shows why structure > sequence, and how embeddings encode folds.

### Wow / TUI Visualization
ASCII contact-map thumbnail; neighbor list with “novelty meter”; highlight loop/patch deltas as inline annotations.

### Implementation Stack
Embeddings offline via Python (TM-Vec/ESMFold); Rust+WASM HNSW/UMAP; SQLite cache; Ink UI components.

---

## 41) Phage–Defense Arms Race Dashboard

### Concept
Summarize anti-CRISPRs, RM evasion motifs, Abi counters, retron/CBASS hits, and Sie systems; score offense/defense balance per phage.

### How to Build
- **Detection**: HMMER for anti-CRISPR families; motif scans for RM evasion; domain scans for Abi/CBASS/retron; Sie heuristics on membrane proteins.
- **Scoring**: Weighted offense/defense index; store with gene links.
- **Cross-phage compare**: Rank phages by offense/defense; show missing counters.

### Why It’s Good
Offers an immediate strategic view of how a phage deals with host defenses; guides cocktail design.

### Novelty
Defense/anti-defense summaries exist in papers; integrated, scored, interactive TUI view is uncommon.

### Pedagogical Value
Teaches the landscape of bacterial defenses and phage countermeasures; clarifies combinatorial strategy.

### Wow / TUI Visualization
Radar/stacked bars for offense vs defense; clicking a wedge jumps to the gene; “missing counter” badges with suggestions.

### Implementation Stack
HMMER precompute; TS scoring; SQLite cache; Ink radar/stacked bars; all CPU, no GPU.

---

## 42) Integration Site & Lifecycle Propensity Scoring (Expanded)

### Concept
Score lysogeny propensity and preferred integration hotspots, blending attP/attB motifs, integrase class, local repeats, and host genome context hints (tRNA/tmRNA preferences).

### How to Build
- **Motifs**: attP/attB/tRNA/tmRNA motif library; scan in TS or Rust+WASM.
- **Integrase typing**: HMMER precompute for tyrosine/serine/invertase-like integrases; link to known site preferences.
- **Scoring**: Combine motif strength, symmetry, repeat content, integrase class priors; estimate excision stability.
- **UI**: Heatmap along genome; site list with confidence and predicted host targets; “simulate integrate here” to see stability.

### Why It’s Good
Predicts where and how stably a phage will integrate; useful for engineering and safety.

### Novelty
Goes beyond simple att finding by adding class-specific priors and repeat-driven stability scoring in a TUI.

### Pedagogical Value
Covers site-specific recombination, integrase specificity, and stability determinants.

### Wow / TUI Visualization
Genome heatmap with peaks; per-site card showing motif logo + predicted host attB; toggle to see excision risk.

### Implementation Stack
Rust+WASM motif scanning optional; HMMER precompute; TS scoring; SQLite cache; Ink heatmap/cards.

---

## 43) Horizontal Gene Transfer Provenance Tracer

### Concept
For each genomic island, infer donor clades using GC/codon atypicality, best-hit taxonomy, and mini phylo placement; generate “passport stamps” per island.

### How to Build
- **Island detection**: GC/codon Z-scores + dinucleotide bias; sliding window in TS or Rust.
- **Donor inference**: Fast k-mer taxonomic assignment (Mash/MinHash) vs reference panel; optional short-tree placement via IQ-TREE-lite binding or neighbor-joining (Rust+WASM).
- **Stamps**: Store donor lineage, confidence, and hallmark genes.

### Why It’s Good
Explains where novel modules came from and how recent the transfer was; guides risk/host-range hypotheses.

### Novelty
Inline provenance “stamps” in a TUI with per-island drilldown is rare.

### Pedagogical Value
Teaches HGT signals (GC/codon skews), taxonomic assignment, and phylogenetic placement.

### Wow / TUI Visualization
Genome bar with colored islands; opening a stamp shows donor pie, GC/codon plots, and top donor references.

### Implementation Stack
TS for GC/codon; Rust+WASM for MinHash and small trees; SQLite cache of islands/stamps; Ink UI.

---

## 44) Functional Module Coherence & Stoichiometry Checker

### Concept
Segment genomes into functional modules (replication, morphogenesis, lysis, regulation) and evaluate stoichiometric balance (e.g., capsid:scaffold, tail fiber sets), flagging incomplete or overrepresented modules.

### How to Build
- **Module detection**: HMMER/domain co-occurrence graphs; rule-based module assignment stored in SQLite.
- **Stoichiometry**: Expected copy ratios per module from literature/structural heuristics; compare to gene presence/duplication.
- **Coherence score**: Penalize missing essentials or excess paralogs; suggest likely missing partners.

### Why It’s Good
Gives a quick “is this genome complete and balanced?” readout; great for QC and design.

### Novelty
Stoichiometry checks inside a TUI phage browser are uncommon.

### Pedagogical Value
Shows structural/assembly stoichiometry and why certain components must be balanced.

### Wow / TUI Visualization
Module ribbon with green/amber/red indicators; hover shows expected vs found counts; “suggest” button highlights nearest homologs that could fill gaps.

### Implementation Stack
HMMER precompute; TS scoring; optional Rust+WASM for fast domain co-occurrence; SQLite cache; Ink module ribbon UI.

---

## 42) Pan-Genome Mosaic & Reassortment Radar

### Concept
Detect mosaicism/recombination by sliding-window lineage assignment and donor likelihoods, revealing which phage lineage best explains each genomic segment and how segments rearrange across a pan-genome.

### How to Build
- **Segmental likelihoods**: Rust+WASM HMM/phylo-likelihood over sliding windows (e.g., 1–5 kb) using Jukes-Cantor/GTR; cache per phage per window.
- **Lineage panel**: Build a light neighbor-joining or UPGMA tree on window consensus; assign “best donor lineage” with bootstrap support.
- **Break detection**: CUSUM/likelihood ratio to flag recombination breakpoints; store break intervals with support scores.
- **Pan-genome tiles**: SQLite table of window → lineage label + support; index by phage and position for instant retrieval.

### Why It’s Good
Recombination is central to phage evolution and host shifts; this makes mosaic structure explorable rather than a static alignment.

### Novelty
High—windowed lineage painting plus breakpoint calling inside a TUI genome viewer is rarely offered.

### Pedagogical Value
Teaches recombination signatures, breakpoint evidence, and lineage mixing; connects phylogenetics to genome architecture.

### Wow / TUI Visualization
Genome ribbon colored by donor lineage; breakpoint flags with support bars; pressing `b` jumps between suspected breakpoints; toggle “show lineage confidence” as transparency.

### Implementation Stack
Rust+WASM for HMM/likelihood + CUSUM; TS/Ink for ribbon view; SQLite for tiled lineage/support cache.

---

## 43) High-Resolution K-mer Anomaly Cartography

### Concept
Map localized k-mer rarity/novelty (z-scores vs a reference corpus) to expose atypical islands (HGT, AMGs, anti-defense loci) and couple with GC/AT skew and coding density.

### How to Build
- **Background model**: Global corpus k-mer frequencies (k=3/5/7/9) precomputed; store means/vars per k.
- **Sliding windows**: Rust+WASM streaming k-mer counter with Welford variance; compute per-window z/LOF (Local Outlier Factor) scores; cache per phage.
- **Composite score**: Fuse z-score, GC skew, coding density into an anomaly score (weighted, configurable).
- **Drill-down**: Link anomalous windows to nearby genes and motifs.

### Why It’s Good
Flags horizontally transferred or defense/AMG islands that simple annotation might miss; prioritizes “what’s weird here?”

### Novelty
Medium-high—alignment-free anomaly heatmaps in-terminal are uncommon.

### Pedagogical Value
Shows statistical outlier detection and why compositional shifts imply biology (HGT, defense, AMGs).

### Wow / TUI Visualization
Scrolling heat-strip under the sequence grid; hotspots pulse; `enter` opens a side panel with top-k k-mers, genes, and putative function.

### Implementation Stack
Rust+WASM sliding k-mer stats; TS/Ink heat-strip; SQLite window cache; optional LOF in Rust with kd-tree.

---

## 44) Phage–Host Codon/Codon-Pair Adaptation Lens

### Concept
Quantify codon adaptation (CAI/RAI) and codon-pair bias per gene versus multiple candidate hosts to reveal host tropism and host-switch footprints.

### How to Build
- **Host profiles**: Precompute host codon/codon-pair frequencies (from known hosts/metagenomes); store in SQLite.
- **Per-gene CAI/RAI**: TS or Rust+WASM vector ops to score each gene against every host profile; produce deltas.
- **Codon-pair bias**: Compute CPB per gene; z-score vs host expectations; highlight genes with host-mismatched CPB.
- **Aggregation**: Summaries per module (structural/replication/lysis).

### Why It’s Good
Connects sequence to host compatibility; aids host prediction and engineering.

### Novelty
Medium—CAI/RAI is known, but multi-host per-gene visualization with CPB deltas in a TUI is fresh.

### Pedagogical Value
Explains translational optimization, host constraints, and adaptation signals.

### Wow / TUI Visualization
Stacked bars per gene colored by “best host”; host-switch candidates glow; toggle to see CAI vs CPB deltas.

### Implementation Stack
TS for CAI/RAI/CPB if performance sufficient; Rust+WASM for batch scoring many hosts; SQLite for host frequency tables.

---

## 45) Amino-Acid Property Phase Portraits

### Concept
Slide across proteins/ORFs computing property vectors (hydropathy, charge, aromaticity, disorder proxies), then project trajectories (PCA/UMAP) to reveal domain compositional signatures and divergence between phages.

### How to Build
- **Property vectors**: TS computation per window (e.g., 30–60 aa) for multiple properties; normalize.
- **Projection**: PCA in TS; optional UMAP via wasm-bindgen to Rust umap-rs for speed; cache embeddings per window.
- **Comparative mode**: Plot trajectories of two phages’ homologous proteins to show divergence.

### Why It’s Good
Highlights domain-level shifts invisible to simple alignments; surfaces regions likely affecting folding/interactions.

### Novelty
Medium-high—trajectory-based property manifolds in a terminal genome tool are rare.

### Pedagogical Value
Teaches property landscapes, low-D projection, and links between composition and function.

### Wow / TUI Visualization
ASCII scatter/trajectory; cursor shows window position; press `d` to jump to the sequence slice; color by property dominance.

### Implementation Stack
TS for property calc + PCA; Rust+WASM UMAP optional; SQLite cache for embeddings; Ink plotting with braille blocks.

---

## 46) Structure-Informed Capsid/Tail Constraint Scanner

### Concept
Score mutations against coarse structural constraints (lattice geometry, contact propensities) to flag mechanically fragile regions and assembly cliffs.

### How to Build
- **Model source**: Use built-in coarse models (renderer-3d) plus optional PDB-derived contact maps.
- **Constraint scoring**: Rust+WASM coarse-grain contact penalty + lattice geometry checks; per-residue “fragility” scores.
- **Mutation scanning**: Single AA substitutions scored via protein LM (ESM) delta + structural penalty blend.
- **Outputs**: Fragility heatmap per structural protein; “do not touch” segments.

### Why It’s Good
Guides engineering (stability vs escape); surfaces structurally sensitive regions.

### Novelty
Medium—structure-aware constraint scoring inline with TUI models is uncommon.

### Pedagogical Value
Shows how structure limits sequence variation; links mutational impact to assembly physics.

### Wow / TUI Visualization
Capsid/tail ASCII view with fragility heatmap overlay; hover a residue to see Δstability; “shake test” animation for fragile builds.

### Implementation Stack
Rust+WASM scoring; optional ESM offline scoring cached; TS/Ink overlays on existing 3D ASCII renderer; SQLite cache for per-residue penalties.

---

## 47) CRISPR Pressure & Anti-CRISPR Landscape

### Concept
Integrate host CRISPR spacer hits, predict anti-CRISPR (Acr) candidates, and visualize the arms race along the genome.

### How to Build
- **Spacer mapping**: Minimap2/mashmap offline to build spacer-hit table; in-app filtering by host.
- **Acr detection**: HMMs for known Acr families; small ORF heuristics; embedding similarity (ESM small) for novel Acr-like hits; run in TS or Rust+WASM for batch scoring.
- **Pressure score**: Combine spacer density, PAM proximity, and coding strand; compute “pressure index” per window.
- **UI links**: Spacer hits → nearby Acr predictions; suggest escape mutations.

### Why It’s Good
Turns CRISPR data into actionable escape/pressure interpretation; ties defense vs counter-defense.

### Novelty
High—combined spacer pressure + Acr prediction ribbon in a TUI is rare.

### Pedagogical Value
Explains spacer targeting, PAMs, Acrs, and evolutionary pressure.

### Wow / TUI Visualization
Pressure bar under genome; spacer hits as tick marks; Acr candidates glow; pressing `c` centers on strongest Acr-vs-spacer clash.

### Implementation Stack
Offline spacer DB (minimap2); Rust+WASM scoring for windowed pressure; TS/Ink visualization; SQLite for hits and pressure tiles.

---

## 48) Dinucleotide & Codon Bias Tensor Decomposition

### Concept
Decompose joint di-/tri-nucleotide and codon-usage patterns across phages into latent “bias modes” (e.g., replication strategy, host clade) and position each genome in that space.

### How to Build
- **Tensor build**: For each phage, compute dinuc/codon frequency vectors; stack into matrix/tensor.
- **Decomposition**: NMF/PCA in Rust+WASM (ndarray + linfa) for speed; store loadings per phage and per-feature.
- **Annotation**: Correlate components with metadata (host, lifecycle, genome type).
- **Per-gene projection**: Optional per-gene loadings to localize bias shifts.

### Why It’s Good
Exposes hidden biases tied to biology (replication enzymes, host context); aids clustering and anomaly detection.

### Novelty
Medium—bias decompositions exist, but in-terminal, interactive latent-space navigation is rare.

### Pedagogical Value
Shows factorization methods and biological interpretation of compositional bias.

### Wow / TUI Visualization
2D latent map with phages as points; hover shows metadata correlations; bar chart of top contributing k-mers for the selected component.

### Implementation Stack
Rust+WASM NMF/PCA; TS UI for scatter + bars; SQLite for loadings and component metadata correlations.

---

## 49) Functional Synteny Elastic Alignment

### Concept
Align gene order between phages using elastic warping on gene families/distances to reveal conserved modules vs shuffled blocks.

### How to Build
- **Gene families**: Cluster proteins via MMseqs2 offline; store family IDs per gene.
- **Elastic alignment**: Rust+WASM dynamic time warping on family sequences with gap penalties reflecting distance; output matched blocks and breakpoints.
- **Scores**: Synteny continuity score; module conservation metrics.
- **Caching**: Precompute pairwise synteny summaries for the 12 core phages; on-demand for others.

### Why It’s Good
Highlights modular genome architecture and rearrangements beyond sequence identity.

### Novelty
Medium-high—elastic synteny with interactive inspection in a TUI is uncommon.

### Pedagogical Value
Teaches genome modularity, rearrangement, and how function/position co-evolve.

### Wow / TUI Visualization
Dual gene bars with elastic “bands” linking orthologous modules; breakpoint markers; pressing `m` cycles modules; `s` shows continuity score.

### Implementation Stack
Rust+WASM DTW; TS/Ink dual-track view; SQLite caches for family IDs and synteny results.

---

## 50) Regulatory Signal Constellations

### Concept
Scan promoters/terminators/RBS/operators and render co-occurring regulatory motifs as “constellations” to reveal operons and control logic.

### How to Build
- **Motif scans**: PWMs for sigma factors, Rho-independent terminators, RBS; run in TS (fast) or Rust+WASM for batch; store hits with scores/phases.
- **Co-occurrence graph**: Build small graph of motifs per region; detect motif “motifs” (e.g., promoter + operator + terminator spacing).
- **Evidence score**: Combine spacing, orientation, and strength into an operon-likelihood.
- **Link to genes**: Tie regions to downstream ORFs; annotate likely operons.

### Why It’s Good
Surfaces regulatory architecture beyond coding genes; aids understanding of control.

### Novelty
Medium—motif scans are common, but co-occurrence constellations with spacing logic in a TUI are fresh.

### Pedagogical Value
Spacing/phase matters; shows how multiple motifs compose regulation.

### Wow / TUI Visualization
Starfield strip above genes; motifs as glyphs; edges show spacing; hover shows PWM score; `o` toggles inferred operons highlighting ORF blocks.

### Implementation Stack
TS PWMs; optional Rust+WASM for speed; SQLite motif hit cache; Ink starfield rendering with braille.

---

## 51) Phylodynamic Trajectory Explorer

### Concept
For dated accessions, build time-scaled trees and visualize rate shifts, skyline Ne, and rapidly evolving loci with selection signals.

### How to Build
- **Tree**: Use a lightweight BEAST-like approximation—rate-smoothed NJ or treetime-style root-to-tip regression in Rust+WASM; infer clock rate.
- **Skyline**: Coalescent skyline via interval counts; compute Ne(t) with credible bands.
- **Selection**: dN/dS per branch/window (FEL-like fast approximation) in Rust+WASM; map to genome positions.
- **Data ingest**: Accession dates + sequences; cache alignments and trees in SQLite.

### Why It’s Good
Shows evolutionary tempo, expansions, and hotspot loci—connects time to genome changes.

### Novelty
High—phylodynamics with selection overlays in a TUI genome browser is rare.

### Pedagogical Value
Teaches molecular clocks, skyline plots, and selection mapping.

### Wow / TUI Visualization
ASCII time-scaled tree; side skyline plot; genome heat strip for dN/dS; cursor on tree highlights corresponding loci.

### Implementation Stack
Rust+WASM for clock/regression/selection; TS/Ink for tree + skyline rendering; SQLite caches for alignments/trees.

---