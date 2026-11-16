import type { Simulation, RibosomeTrafficState, SimulationContext } from '../simulation';
import type { GeneInfo, PhageFull } from '../types';
import { getGeneticCode } from '../codons';
import { GENOME_IMPORT_LIMITS, getGeneMapSegments } from '../genome-import';
import { reconstructCdsReference, type CdsReference } from './cds-consequences';

const DEFAULT_INITIATION_RATE = 0.5;
const DEFAULT_TERMINATION_RATE = 0.8;
const FOOTPRINT = 9; // codons

export const RIBOSOME_TRAFFIC_LIMITS = {
  genomeBases: GENOME_IMPORT_LIMITS.bases,
  genes: GENOME_IMPORT_LIMITS.features,
  codons: 20000,
  stepsPerCall: 10000,
} as const;

export const RIBOSOME_TRAFFIC_ASSUMPTIONS =
  'Discrete ordered exclusion model. Entry and exit occur at the represented CDS boundaries, including partial CDS; completed tracks are not measured protein production. ' +
  'Sense-codon departure probability is 0.1 + 0.9 × its count/max synonymous count in this selected CDS under its declared genetic code. ' +
  'Codon frequency is a teaching heuristic, not measured tRNA supply, elongation speed or translation efficiency; time is in model steps.';

/** The same deterministic selection is used by both frontends and the model. */
export function selectRibosomeTrafficGene(phage: PhageFull, geneId?: number): GeneInfo {
  if (!Array.isArray(phage.genes) || phage.genes.length > RIBOSOME_TRAFFIC_LIMITS.genes) {
    throw new Error('Ribosome traffic requires at most 50,000 annotated features.');
  }
  if (geneId !== undefined && (!Number.isSafeInteger(geneId) || geneId < 0)) {
    throw new Error('Select a nonnegative integer CDS ID.');
  }
  const genes = phage.genes.filter(gene => gene.type === 'CDS');
  if (geneId !== undefined) {
    const selected = genes.filter(gene => gene.id === geneId);
    if (selected.length !== 1) throw new Error('The selected CDS ID must identify exactly one annotated CDS in this genome.');
    return selected[0];
  }
  if (!genes.length) throw new Error('No annotated CDS is available. Import a GenBank record with CDS features.');
  const length = (gene: GeneInfo): number => getGeneMapSegments(gene).reduce((sum, part) => sum + part.end - part.start, 0);
  const selected = genes.map(gene => ({ gene, length: length(gene) }))
    .sort((a, b) => b.length - a.length || a.gene.id - b.gene.id)[0].gene;
  if (genes.filter(gene => gene.id === selected.id).length !== 1) {
    throw new Error('The selected CDS ID must identify exactly one annotated CDS in this genome.');
  }
  return selected;
}

function exactTranscript(phage: PhageFull, context?: SimulationContext): CdsReference {
  if (!context || typeof context.genomeSequence !== 'string' || !context.genomeSequence.length) {
    throw new Error('Load the complete genome sequence before simulating an annotated CDS.');
  }
  if (context.genomeSequence.length > RIBOSOME_TRAFFIC_LIMITS.genomeBases || /[^ACGTRYSWKMBDHVN]/i.test(context.genomeSequence)) {
    throw new Error('Ribosome traffic requires at most 5,000,000 IUPAC DNA bases without gaps or changed coordinates.');
  }
  if (phage.genomeLength != null && phage.genomeLength !== context.genomeSequence.length) {
    throw new Error('The complete genome sequence length differs from the selected phage.');
  }
  const gene = selectRibosomeTrafficGene(phage, context.geneId);
  const segments = getGeneMapSegments(gene);
  if (segments.length > GENOME_IMPORT_LIMITS.segments ||
    segments.reduce((sum, part) => sum + part.end - part.start, 0) > RIBOSOME_TRAFFIC_LIMITS.codons * 3 + 2) {
    throw new Error('Selected CDS exceeds the 20,000-codon or 1,000-segment simulation limit; no truncated track was created.');
  }
  const transcript = reconstructCdsReference(gene, context.genomeSequence.toUpperCase());
  if (transcript.reasons.length || !transcript.cds || !transcript.protein) {
    throw new Error(`Selected CDS is unavailable: ${transcript.reasons.join(' ') || 'No complete coding bases.'}`);
  }
  if (!transcript.protein.replace(/\*$/, '').length) throw new Error('Selected CDS has no sense codon to simulate.');
  if (transcript.cds.length / 3 > RIBOSOME_TRAFFIC_LIMITS.codons) throw new Error('Selected CDS exceeds the 20,000-codon simulation limit.');
  return transcript;
}

function codonProbabilities(transcript: CdsReference): number[] {
  const table = getGeneticCode(transcript.geneticCode).codons;
  const cds = transcript.cds!;
  const counts = new Map<string, number>();
  const maxima = new Map<string, number>();
  for (let position = 0; position < cds.length; position += 3) {
    const codon = cds.slice(position, position + 3);
    if (table[codon] === '*') continue;
    counts.set(codon, (counts.get(codon) ?? 0) + 1);
  }
  for (const [codon, count] of counts) maxima.set(table[codon], Math.max(maxima.get(table[codon]) ?? 0, count));
  return Array.from({ length: cds.length / 3 }, (_, index) => {
    const codon = cds.slice(index * 3, index * 3 + 3);
    // A terminal stop is an exit site controlled by beta, not a tRNA-decoded codon.
    return table[codon] === '*' ? 1 : 0.1 + 0.9 * counts.get(codon)! / maxima.get(table[codon])!;
  });
}

function validateParameters(params: Record<string, number | boolean | string>): void {
  for (const name of ['initiationRate', 'terminationRate']) {
    const value = params[name];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new Error(`${name} must be a finite probability from 0 to 1.`);
    }
  }
  const footprint = params.footprint;
  if (typeof footprint !== 'number' || !Number.isSafeInteger(footprint) || footprint < 1 || footprint > 20) {
    throw new Error('Ribosome footprint must be an integer from 1 to 20 codons.');
  }
}

export const ribosomeTrafficSimulation: Simulation<RibosomeTrafficState> = {
  id: 'ribosome-traffic',
  name: 'Ribosome Traffic Simulator',
  description: 'Explore exclusion dynamics along an exact annotated CDS using declared codon-frequency probabilities, not measured translation rates.',
  icon: '🚗',

  parameters: [
    {
      id: 'initiationRate',
      label: 'Initiation Rate (α)',
      description: 'Probability of new ribosome binding per step',
      type: 'number',
      min: 0,
      max: 1.0,
      step: 0.01,
      defaultValue: DEFAULT_INITIATION_RATE,
    },
    {
      id: 'terminationRate',
      label: 'Termination Rate (β)',
      description: 'Probability of ribosome release at stop per step',
      type: 'number',
      min: 0,
      max: 1.0,
      step: 0.01,
      defaultValue: DEFAULT_TERMINATION_RATE,
    },
    {
      id: 'footprint',
      label: 'Ribosome Footprint',
      description: 'Number of codons a ribosome occupies',
      type: 'number',
      min: 1,
      max: 20,
      step: 1,
      defaultValue: FOOTPRINT,
    },
  ],

  controls: [
    { id: 'pause', label: 'Pause/Resume', icon: '⏯', shortcut: 'Space', action: 'pause' },
    { id: 'reset', label: 'Reset', icon: '🔄', shortcut: 'R', action: 'reset' },
    { id: 'step', label: 'Step', icon: '→', shortcut: '.', action: 'step' },
    { id: 'speed-up', label: 'Faster', icon: '⏩', shortcut: '+', action: 'speed-up' },
    { id: 'speed-down', label: 'Slower', icon: '⏪', shortcut: '-', action: 'speed-down' },
  ],

  init: (phage: PhageFull | null = null, params = {}, rng?: () => number, context?: SimulationContext): RibosomeTrafficState => {
    const random = rng ?? Math.random;
    const resolved = {
      initiationRate: DEFAULT_INITIATION_RATE,
      terminationRate: DEFAULT_TERMINATION_RATE,
      footprint: FOOTPRINT,
      ...params,
    } as Record<string, number | boolean | string>;
    validateParameters(resolved);
    if (!phage && context) throw new Error('A genome sequence requires its matching annotated phage; it cannot select the synthetic demonstration.');
    const transcript = phage ? exactTranscript(phage, context) : null;
    const codonRates = transcript ? codonProbabilities(transcript) : Array.from({ length: 200 }, () => 0.1 + random() * 0.9);

    return {
      type: 'ribosome-traffic',
      time: 0,
      running: false,
      speed: 1,
      params: resolved,
      mRnaId: transcript ? transcript.product ?? transcript.name : 'Synthetic',
      transcript,
      source: transcript ? 'annotated-cds' : 'synthetic',
      rateModel: transcript ? 'selected-cds-synonymous-frequency-v1' : 'synthetic-uniform-v1',
      pendingSteps: 0,
      ribosomes: [],
      codonRates,
      proteinsProduced: 0,
      stallEvents: 0,
      densityHistory: Array(40).fill(0),
      productionHistory: Array(40).fill(0),
      stallHistory: Array(40).fill(0),
    };
  },

  step: (state: RibosomeTrafficState, dt: number, rng?: () => number): RibosomeTrafficState => {
    const random = rng ?? Math.random;
    validateParameters(state.params);
    if (!Number.isFinite(dt) || dt < 0 || dt > RIBOSOME_TRAFFIC_LIMITS.stepsPerCall) {
      throw new Error('Time delta must be finite and between 0 and 10,000 model steps.');
    }
    if (!Number.isFinite(state.pendingSteps) || state.pendingSteps < 0 || state.pendingSteps >= 1) {
      throw new Error('Invalid fractional ribosome step accumulator.');
    }
    if (!state.codonRates.length || state.codonRates.length > RIBOSOME_TRAFFIC_LIMITS.codons ||
      state.codonRates.some(rate => !Number.isFinite(rate) || rate < 0 || rate > 1)) {
      throw new Error('Ribosome track needs finite departure probabilities from 0 to 1 for every codon.');
    }
    const footprint = Number(state.params.footprint);
    if (state.ribosomes.some((position, index) => !Number.isSafeInteger(position) || position < 0 || position >= state.codonRates.length ||
      index > 0 && state.ribosomes[index - 1] - position < footprint)) {
      throw new Error('Ribosome positions must be ordered, in bounds and separated by their footprint. Reset after changing footprint.');
    }
    const accumulated = state.pendingSteps + dt;
    const nearest = Math.round(accumulated);
    // Decimal partitions can land a few ULPs below a completed step. Snap
    // only near positive integer boundaries; retain tiny positive fractions.
    const snapped = nearest >= 1 && Math.abs(accumulated - nearest) <=
      8 * Number.EPSILON * Math.max(1, Math.abs(accumulated)) ? nearest : accumulated;
    const totalSteps = Math.floor(snapped);
    const pendingSteps = snapped - totalSteps;
    
    if (totalSteps === 0) {
      return {
        ...state,
        time: state.time + dt,
        pendingSteps,
      };
    }

    let currentRibosomes = state.ribosomes;
    let currentProteins = state.proteinsProduced;
    let currentStalls = state.stallEvents;

    for (let s = 0; s < totalSteps; s++) {
      const result = runSingleTasepStep(
        currentRibosomes,
        currentProteins,
        currentStalls,
        state.codonRates,
        state.params,
        random
      );
      currentRibosomes = result.ribosomes;
      currentProteins = result.proteinsProduced;
      currentStalls = result.stallEvents;
    }

    // Update history only once per frame
    const newDensityHistory = [...state.densityHistory.slice(1), currentRibosomes.length];
    const newProductionHistory = [...state.productionHistory.slice(1), currentProteins];
    const newStallHistory = [...(state.stallHistory || Array(40).fill(0)).slice(1), currentStalls];

    return {
      ...state,
      time: state.time + dt,
      pendingSteps,
      ribosomes: currentRibosomes,
      proteinsProduced: currentProteins,
      stallEvents: currentStalls,
      densityHistory: newDensityHistory,
      productionHistory: newProductionHistory,
      stallHistory: newStallHistory,
    };
  },

  getSummary: (state: RibosomeTrafficState) => {
    return `Ribosomes: ${state.ribosomes.length} | Completed tracks: ${state.proteinsProduced} | Blocked attempts: ${state.stallEvents}`;
  },
};

function runSingleTasepStep(
  ribosomes: number[],
  proteinsProduced: number,
  stallEvents: number,
  codonRates: number[],
  params: Record<string, number | boolean | string>,
  random: () => number
): { ribosomes: number[]; proteinsProduced: number; stallEvents: number } {
    const alpha = Number(params.initiationRate);
    const beta = Number(params.terminationRate);
    const footprint = Number(params.footprint);
    const length = codonRates.length;

    let stalls = 0;
    let proteins = proteinsProduced;

    // Process ribosomes from 3' end (oldest) to 5' end (newest)
    // Input `ribosomes` is sorted [Oldest ... Newest]
    const newPositions: number[] = [];
    
    for (let i = 0; i < ribosomes.length; i++) {
        const pos = ribosomes[i];
        
        // Check if this ribosome is at the end (termination)
        if (pos >= length - 1) {
            // Try terminate
            if (random() < beta) {
                // Success: remove (don't add)
                proteins++;
                continue;
            } else {
                // Failed: stay
                newPositions.push(pos);
                continue;
            }
        }
        
        // Elongation
        const rate = codonRates[pos];
        
        // Check obstruction from the ribosome ahead (which was just processed)
        let blocked = false;
        if (newPositions.length > 0) {
            const leadingPos = newPositions[newPositions.length - 1]; 
            if (leadingPos - (pos + 1) < footprint) {
                blocked = true;
            }
        }
        
        if (blocked) {
            stalls++;
            newPositions.push(pos);
        } else {
            // Try move
            if (random() < rate) {
                newPositions.push(pos + 1);
            } else {
                newPositions.push(pos);
            }
        }
    }
    
    // 3. Initiation
    // Check if the most upstream ribosome (last processed) blocks start
    let startBlocked = false;
    if (newPositions.length > 0) {
        if (newPositions[newPositions.length - 1] < footprint) {
            startBlocked = true;
        }
    }
    
    if (!startBlocked) {
        if (random() < alpha) {
            newPositions.push(0);
        }
    }
    
    return {
      ribosomes: newPositions, // Order preserved [Oldest ... Newest]
      proteinsProduced: proteins,
      stallEvents: stallEvents + stalls,
    };
}
