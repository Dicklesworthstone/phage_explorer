/**
 * Overlay Components Exports
 */

// Provider and hooks
export {
  OverlayProvider,
  useOverlay,
  useIsTopOverlay,
  useOverlayZIndex,
  type OverlayId,
  type OverlayConfig,
} from './OverlayProvider';

// Base component
export { Overlay, type OverlaySize, type OverlayPosition } from './Overlay';

// Manager
export { OverlayManager } from './OverlayManager';

// Core overlays
export { HelpOverlay } from './HelpOverlay';
export { CommandPalette } from './CommandPalette';
export { AnalysisMenu } from './AnalysisMenu';
export { SimulationHub } from './SimulationHub';
export { WelcomeModal } from './WelcomeModal';
export { CollaborationOverlay } from './CollaborationOverlay';
export { FeatureTour } from './FeatureTour';

// Layer 1 Analysis Overlays
export { GCSkewOverlay } from './GCSkewOverlay';
export { ComplexityOverlay } from './ComplexityOverlay';
export * from './ModuleOverlay';
export * from './BendabilityOverlay';

export { PromoterOverlay } from './PromoterOverlay';
export { RepeatsOverlay } from './RepeatsOverlay';
export { TranscriptionFlowOverlay } from './TranscriptionFlowOverlay';
export { RecentCommands } from './RecentCommands';

// Layer 2 Advanced Overlays
export { KmerAnomalyOverlay } from './KmerAnomalyOverlay';
export { SelectionPressureOverlay } from './SelectionPressureOverlay';

