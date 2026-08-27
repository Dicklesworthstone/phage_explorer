/**
 * Store Module Exports
 *
 * Provides the main application store, web-specific preferences, and
 * web-only interaction state such as the selected genome feature.
 */

// Re-export main store
export {
  usePhageStore,
  type PhageExplorerStore,
  type PhageExplorerState,
  type PhageExplorerActions,
} from './createWebStore';

// Re-export additional types/hooks from state package
export {
  useCurrentPhageSummary,
  useGridDimensions,
  useOverlayStack,
  useTopOverlay,
  useActiveSimulation,
  useSimulationState,
  useSimulationPaused,
  useSimulationSpeed,
  useIsSimulationActive,
  useExperienceLevel,
  useHelpDetail,
  type OverlayId,
  type HelpDetailLevel,
  type ExperienceLevel,
  type ComparisonTab,
} from '@phage-explorer/state';

// Web preferences store
export {
  useWebPreferences,
  type WebPreferencesState,
  type WebPreferencesActions,
  type WebPreferencesStore,
} from './createWebStore';

// Selected gene interaction state
export {
  useSelectedGeneStore,
  type SelectedGeneState,
  type SelectedGeneActions,
  type SelectedGeneStore,
} from './selectedGeneStore';

// Persistence utilities
export {
  initializeStorePersistence,
  hydrateMainStoreFromStorage,
  allowHeavyFx,
  detectCoarsePointerDevice,
  getEffectiveBackgroundEffects,
  getEffectiveGlow,
  getEffectiveScanlines,
  get3DViewerDisabledDescription,
  get3DViewerDisabledDescriptionForPolicy,
  getShow3DModelDefaultPolicy,
  inferDefaultShow3DModel,
  subscribeMainStoreToStorage,
  syncPreferencesToStorage,
  createWebStore,
} from './createWebStore';
