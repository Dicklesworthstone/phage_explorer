import type { ModuleId } from '../types';
import { WhatIsPhageModule } from './WhatIsPhage';
import { DNABasicsModule } from './DNABasics';
import { PhageLifecycleModule } from './PhageLifecycle';
import { GeneticCodeModule } from './GeneticCode';
import { CentralDogmaModule } from './CentralDogma';

export type ModuleComponent = () => JSX.Element;

export interface ModuleMeta {
  id: ModuleId;
  title: string;
  description: string;
  estimatedMinutes: number;
  component: ModuleComponent;
}

export const FOUNDATION_MODULES: ModuleMeta[] = [
  {
    id: 'intro-to-phages',
    title: 'What is a bacteriophage?',
    description: 'Structure, lifecycle overview, historical milestones, and why phages matter.',
    estimatedMinutes: 8,
    component: WhatIsPhageModule,
  },
  {
    id: 'dna-basics',
    title: 'DNA Basics for Engineers',
    description: '4-base alphabet, double helix structure, base pairing rules, 5\' to 3\' directionality.',
    estimatedMinutes: 10,
    component: DNABasicsModule,
  },
  {
    id: 'phage-lifecycle',
    title: 'Phage Lifecycle',
    description: 'Lytic and lysogenic cycles, temperate vs virulent phages, Lambda decision circuit.',
    estimatedMinutes: 12,
    component: PhageLifecycleModule,
  },
  {
    id: 'central-dogma',
    title: 'The Central Dogma',
    description: 'DNA → RNA → Protein flow, transcription, translation, why sequence predicts function.',
    estimatedMinutes: 12,
    component: CentralDogmaModule,
  },
  {
    id: 'genetic-code',
    title: 'The Genetic Code',
    description: 'Codons, amino acids, degeneracy, start/stop signals, reading frames, codon bias.',
    estimatedMinutes: 12,
    component: GeneticCodeModule,
  },
];

export { WhatIsPhageModule } from './WhatIsPhage';
export { DNABasicsModule } from './DNABasics';
export { PhageLifecycleModule } from './PhageLifecycle';
export { CentralDogmaModule } from './CentralDogma';
export { GeneticCodeModule } from './GeneticCode';
