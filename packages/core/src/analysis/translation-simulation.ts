import type { Simulation, RibosomeTrafficState } from '../simulation';
import type { PhageFull } from '../types';

const DEFAULT_INITIATION_RATE = 0.5;
const DEFAULT_TERMINATION_RATE = 0.8;
const FOOTPRINT = 9; // codons

export const ribosomeTrafficSimulation: Simulation<RibosomeTrafficState> = {
  id: 'ribosome-traffic',
  name: 'Ribosome Traffic Simulator',
  description: 'Simulate translation dynamics, bottlenecks, and collisions based on codon usage bias.',
  icon: '🚗',

  parameters: [
    {
      id: 'initiationRate',
      label: 'Initiation Rate (α)',
      description: 'Probability of new ribosome binding per step',
      type: 'number',
      min: 0.01,
      max: 1.0,
      step: 0.01,
      defaultValue: DEFAULT_INITIATION_RATE,
    },
    {
      id: 'terminationRate',
      label: 'Termination Rate (β)',
      description: 'Probability of ribosome release at stop per step',
      type: 'number',
      min: 0.01,
      max: 1.0,
      step: 0.01,
      defaultValue: DEFAULT_TERMINATION_RATE,
    },
    {
      id: 'footprint',
      label: 'Ribosome Footprint',
      description: 'Number of codons a ribosome occupies',
      type: 'number',
      min: 5,
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

  init: (phage: PhageFull | null = null, params = {}, rng?: () => number): RibosomeTrafficState => {
    const random = rng ?? Math.random;
    let codonRates: number[] = [];
    let mRnaId = 'Synthetic';

    if (phage && phage.genes && phage.genes.length > 0) {
      // Pick the longest gene for interesting dynamics
      const gene = [...phage.genes].sort((a, b) => (b.endPos - b.startPos) - (a.endPos - a.startPos))[0];
      mRnaId = gene.product ?? gene.locusTag ?? `Gene ${gene.id}`;
      
      const geneLen = Math.floor((gene.endPos - gene.startPos) / 3);
      const len = Math.min(1000, Math.max(100, geneLen));

      // Use codon usage to generate "realistic" rate landscape
      // Rare codons -> slow (low rate), Abundant -> fast (high rate)
      if (phage.codonUsage && phage.codonUsage.codonCounts) {
        const counts = Object.values(phage.codonUsage.codonCounts);
        const maxCount = Math.max(1, ...counts);
        
        // Generate rates based on sampling from the usage distribution
        // (Since we don't have the exact sequence, we simulate a gene with similar codon bias)
        codonRates = Array.from({ length: len }, () => {
          // Pick a random codon based on frequency? 
          // Simplified: just pick a random efficiency from the genome's distribution
          const randomCount = counts[Math.floor(random() * counts.length)] ?? 1;
          const efficiency = randomCount / maxCount;
          // Map efficiency 0..1 to rate 0.1..1.0
          return 0.1 + efficiency * 0.9;
        });
      } else {
        // Fallback if no usage data
        codonRates = Array.from({ length: len }, () => 0.1 + random() * 0.9);
      }
    } else {
      // Synthetic mRNA
      codonRates = Array.from({ length: 200 }, () => 0.1 + random() * 0.9);
    }

    return {
      type: 'ribosome-traffic',
      time: 0,
      running: false,
      speed: 1,
      params: {
        initiationRate: DEFAULT_INITIATION_RATE,
        terminationRate: DEFAULT_TERMINATION_RATE,
        footprint: FOOTPRINT,
        ...params,
      },
      mRnaId,
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
    
    // Determine number of discrete steps to execute
    // discrete speed scaling: floor(dt) steps + probability check for remainder
    const steps = Math.floor(dt);
    const remainder = dt - steps;
    const totalSteps = steps + (random() < remainder ? 1 : 0);
    
    if (totalSteps === 0) {
      return {
        ...state,
        time: state.time + dt
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
      ribosomes: currentRibosomes,
      proteinsProduced: currentProteins,
      stallEvents: currentStalls,
      densityHistory: newDensityHistory,
      productionHistory: newProductionHistory,
      stallHistory: newStallHistory,
    };
  },

  getSummary: (state: RibosomeTrafficState) => {
    return `Ribosomes: ${state.ribosomes.length} | Proteins: ${state.proteinsProduced} | Stalls: ${state.stallEvents}`;
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

    // Rebuild positions from 3' to 5' to handle exclusion.
    const newPositionsReversed: number[] = [];
    
    for (let i = ribosomes.length - 1; i >= 0; i--) {
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
                newPositionsReversed.push(pos);
                continue;
            }
        }
        
        // Elongation
        const rate = codonRates[pos] || 0.1;
        
        // Check obstruction from the ribosome ahead
        let blocked = false;
        if (newPositionsReversed.length > 0) {
            const nextPos = newPositionsReversed[newPositionsReversed.length - 1]; 
            if (nextPos - pos < footprint) {
                blocked = true;
            }
        }
        
        if (blocked) {
            stalls++;
            newPositionsReversed.push(pos);
        } else {
            // Try move
            if (random() < rate) {
                newPositionsReversed.push(pos + 1);
            } else {
                newPositionsReversed.push(pos);
            }
        }
    }
    
    // 3. Initiation
    // Check if first ribosome (now the last element of newPositionsReversed) blocks start
    let startBlocked = false;
    if (newPositionsReversed.length > 0) {
        if (newPositionsReversed[newPositionsReversed.length - 1] < footprint) {
            startBlocked = true;
        }
    }
    
    if (!startBlocked) {
        if (random() < alpha) {
            newPositionsReversed.push(0);
        }
    }
    
    return {
      ribosomes: newPositionsReversed.reverse(),
      proteinsProduced: proteins,
      stallEvents: stallEvents + stalls,
    };
}
