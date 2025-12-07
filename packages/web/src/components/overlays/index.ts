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

// Overlay implementations
export { HelpOverlay } from './HelpOverlay';
export { CommandPalette } from './CommandPalette';
export { AnalysisMenu } from './AnalysisMenu';
export { SimulationHub } from './SimulationHub';
export { GCSkewOverlay } from './GCSkewOverlay';
