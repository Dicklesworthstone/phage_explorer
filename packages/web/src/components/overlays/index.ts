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

// Core overlays
export { HelpOverlay } from './HelpOverlay';
export { CommandPalette } from './CommandPalette';
export { AnalysisMenu } from './AnalysisMenu';
export { SimulationHub } from './SimulationHub';

// Layer 1 Analysis Overlays
export { GCSkewOverlay } from './GCSkewOverlay';
export { ComplexityOverlay } from './ComplexityOverlay';
export { BendabilityOverlay } from './BendabilityOverlay';
export { PromoterOverlay } from './PromoterOverlay';
export { RepeatsOverlay } from './RepeatsOverlay';

// Layer 2 Advanced Overlays
export { KmerAnomalyOverlay } from './KmerAnomalyOverlay';
export { SelectionPressureOverlay } from './SelectionPressureOverlay';
