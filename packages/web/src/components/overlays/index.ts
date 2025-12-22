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
export { SearchOverlay } from './SearchOverlay';
export { TropismOverlay } from './TropismOverlay';
export { AAKeyOverlay } from './AAKeyOverlay';
export { AALegend } from './AALegend';
export { ComparisonOverlay } from './ComparisonOverlay';
export { PackagingPressureOverlay } from './PackagingPressureOverlay';
export { CGROverlay } from './CGROverlay';
export { HilbertOverlay } from './HilbertOverlay';
export { VirionStabilityOverlay } from './VirionStabilityOverlay';
export { AnomalyOverlay } from './AnomalyOverlay';
export { CRISPROverlay } from './CRISPROverlay';
export { SyntenyOverlay } from './SyntenyOverlay';
export { DotPlotOverlay } from './DotPlotOverlay';
export { SettingsOverlay } from './SettingsOverlay';

// Layer 2 Advanced Overlays
export { KmerAnomalyOverlay } from './KmerAnomalyOverlay';
export { SelectionPressureOverlay } from './SelectionPressureOverlay';
export { ProphageExcisionOverlay } from './ProphageExcisionOverlay';
export { MosaicRadarOverlay } from './MosaicRadarOverlay';
export { HGTOverlay } from './HGTOverlay';
export { LogoOverlay } from './LogoOverlay';

// Advanced Analysis Overlays
export { RNAStructureOverlay } from './RNAStructureOverlay';
export { ResistanceEvolutionOverlay } from './ResistanceEvolutionOverlay';
export { NicheNetworkOverlay } from './NicheNetworkOverlay';
export { PhylodynamicsOverlay } from './PhylodynamicsOverlay';
export { EnvironmentalProvenanceOverlay } from './EnvironmentalProvenanceOverlay';

// Primitives
export * from './primitives';
