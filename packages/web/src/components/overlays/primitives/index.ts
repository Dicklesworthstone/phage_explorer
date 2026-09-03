// Re-export types (note: GenomeTrack component and GenomeTrack type both exported)
export * from './types';
export * from './HeatmapCanvas';
export * from './ScatterCanvas';
export * from './ArcDiagram';
export { GenomeTrack } from './GenomeTrack';
export type { GenomeTrackProps } from './GenomeTrack';
export * from './GelCanvas';
export * from './OverlayProvenance';
export * from './HowDoIKnowThis';
export * from '../../primitives/colorScales';
export * from '../../primitives/ColorLegend';

// Overlay chrome primitives (UI structure components)
export {
  OverlaySection,
  OverlaySectionHeader,
  OverlayToolbar,
  OverlayGrid,
  OverlayRow,
  OverlayKeyValue,
  OverlayBadge,
  OverlayStack,
  // Data display
  OverlayDescription,
  OverlayStatCard,
  OverlayStatGrid,
  // State primitives
  OverlayLoadingState,
  OverlayEmptyState,
  OverlayErrorState,
  // Legend primitives
  OverlayLegend,
  OverlayLegendItem,
} from './OverlayChrome';
