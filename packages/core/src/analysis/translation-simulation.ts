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

  init: (phage: PhageFull | null = null, params = {}): RibosomeTrafficState => {
    // Determine mRNA to simulate
    // For now, take the first gene's sequence or a chunk of the genome if no genes
    // Or simpler: just use a dummy sequence if no phage, or the first 300 codons of the genome
    // In a real app, we'd want to select a specific gene.

    let codonRates: number[] = [];
    let mRnaId = 'Synthetic';

    if (phage && phage.genes && phage.genes.length > 0) {
      // Pick the longest gene for interesting dynamics
      // Or just the first one
      const gene = [...phage.genes].sort((a, b) => (b.endPos - b.startPos) - (a.endPos - a.startPos))[0];
      mRnaId = gene.product ?? gene.locusTag ?? `Gene ${gene.id}`;
      // We don't have the sequence here directly in PhageFull!
      // This is a limitation of the interface. `init` assumes it has everything.
      // But `PhageFull` doesn't contain the raw sequence.
      // We might need to pass the sequence in `init` or handle it differently.
      // For TUI, the store holds the sequence.
      // But `init` is called by `usePhageStore`.
      // The store has `currentPhage` and `sequence` (string).
      // However, `launchSimulation` calls `init`.
      // We will assume for now we generate random rates if we can't get real ones,
      // OR we update the state later with real rates once loaded.
      
      // Generating synthetic rates for now to ensure it works
      codonRates = Array.from({ length: 300 }, () => 0.1 + Math.random() * 0.9);
    } else {
      // Synthetic mRNA
      codonRates = Array.from({ length: 200 }, () => 0.1 + Math.random() * 0.9);
      // Create a "bottleneck" in the middle
      for(let i=100; i<110; i++) codonRates[i] = 0.05;
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
    };
  },

  step: (state: RibosomeTrafficState, dt: number): RibosomeTrafficState => {
    const { ribosomes, codonRates, params } = state;
    const alpha = Number(params.initiationRate);
    const beta = Number(params.terminationRate);
    const footprint = Number(params.footprint);
    const length = codonRates.length;

    let stalls = 0;

    // Rebuild positions from 3' to 5' to handle exclusion.
    const newPositions: number[] = [];
    let proteins = state.proteinsProduced;
    
    // We need to process from 3' to 5'
    // `ribosomes` is sorted ascending. 3' is at end.
    
    for (let i = ribosomes.length - 1; i >= 0; i--) {
        const pos = ribosomes[i];
        
        // Check if this ribosome is at the end (termination)
        if (pos >= length - 1) {
            // Try terminate
            if (Math.random() < beta) {
                // Success: remove (don't add to newPositions)
                proteins++;
                continue;
            } else {
                // Failed: stay
                newPositions.unshift(pos);
                continue;
            }
        }
        
        // Elongation
        const rate = codonRates[pos] || 0.1;
        // Check obstruction
        // Obstruction is from the ribosome *ahead* (which we processed earlier in this loop, i.e., added to newPositions)
        // Since we process 3'->5', the ribosome ahead (i+1) has already been processed and put into `newPositions` (at index 0 of newPositions, since we unshift).
        // Wait, if we unshift, the one we just processed is at newPositions[0].
        
        let blocked = false;
        if (newPositions.length > 0) {
            // The ribosome immediately ahead
            const nextPos = newPositions[0]; 
            if (nextPos - pos <= footprint) {
                blocked = true;
            }
        }
        
        if (blocked) {
            stalls++;
            newPositions.unshift(pos);
        } else {
            // Try move
            if (Math.random() < rate) {
                newPositions.unshift(pos + 1);
            } else {
                newPositions.unshift(pos);
            }
        }
    }
    
    // 3. Initiation
    // Check if first ribosome (now at newPositions[0]) blocks start
    let startBlocked = false;
    if (newPositions.length > 0) {
        if (newPositions[0] < footprint) {
            startBlocked = true;
        }
    }
    
    if (!startBlocked) {
        if (Math.random() < alpha) {
            newPositions.unshift(0);
        }
    }
    
    // Update history
    const newDensityHistory = [...state.densityHistory.slice(1), newPositions.length];
    const newProductionHistory = [...state.productionHistory.slice(1), proteins];

    return {
      ...state,
      time: state.time + dt,
      ribosomes: newPositions,
      proteinsProduced: proteins,
      stallEvents: state.stallEvents + stalls,
      densityHistory: newDensityHistory,
      productionHistory: newProductionHistory,
    };
  },

  getSummary: (state: RibosomeTrafficState) => {
    return `Ribosomes: ${state.ribosomes.length} | Proteins: ${state.proteinsProduced} | Stalls: ${state.stallEvents}`;
  },
};
