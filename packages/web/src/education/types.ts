/**
 * Education module shared types
 *
 * Type definitions for beginner mode and educational features
 */

/** Identifiers for guided tours */
export type TourId =
  | 'welcome'
  | 'sequence-basics'
  | 'gene-explorer'
  | 'navigation'
  | 'overlays'
  | 'comparison'
  | 'simulations'
  | 'advanced-features';

/** Identifiers for educational modules */
export type ModuleId =
  | 'intro-to-phages'
  | 'dna-basics'
  | 'central-dogma'
  | 'genetic-code'
  | 'phage-lifecycle'
  | 'genomics-basics';

/** Topic identifiers for context-aware help */
export type TopicId =
  | 'dna-sequence'
  | 'amino-acid'
  | 'codon'
  | 'reading-frame'
  | 'gc-content'
  | 'gc-skew'
  | 'complexity'
  | 'promoter'
  | 'rbs'
  | 'gene'
  | 'cds'
  | 'phage-genome'
  | 'capsid'
  | 'tail-fiber'
  | 'lysogeny'
  | 'lytic-cycle';

/** Glossary entry for educational content */
export interface GlossaryEntry {
  id: TopicId;
  term: string;
  shortDefinition: string;
  longDefinition: string;
  relatedTerms: TopicId[];
  category: 'molecular' | 'genomics' | 'phage' | 'analysis' | 'general';
  exampleContext?: string;
  visualAid?: string; // Reference to diagram/animation
}

/** Tour step definition */
export interface TourStep {
  id: string;
  title: string;
  content: string;
  target?: string; // CSS selector for element to highlight
  position?: 'top' | 'bottom' | 'left' | 'right' | 'center';
  action?: 'click' | 'hover' | 'none';
  nextCondition?: 'click' | 'timer' | 'action';
}

/** Complete tour definition */
export interface Tour {
  id: TourId;
  title: string;
  description: string;
  steps: TourStep[];
  estimatedMinutes: number;
  prerequisiteTours?: TourId[];
}

/** Educational module content */
export interface EducationalModule {
  id: ModuleId;
  title: string;
  description: string;
  sections: ModuleSection[];
  estimatedMinutes: number;
  prerequisiteModules?: ModuleId[];
}

/** Section within an educational module */
export interface ModuleSection {
  id: string;
  title: string;
  content: string;
  visualAid?: string;
  quiz?: QuizQuestion[];
}

/** Quiz question for module assessment */
export interface QuizQuestion {
  id: string;
  question: string;
  options: string[];
  correctIndex: number;
  explanation: string;
}

/** Beginner mode user progress */
export interface BeginnerProgress {
  completedTours: TourId[];
  completedModules: ModuleId[];
  currentTour?: TourId;
  currentTourStep?: number;
  glossaryViewedTerms: TopicId[];
  lastActiveAt: Date;
}
