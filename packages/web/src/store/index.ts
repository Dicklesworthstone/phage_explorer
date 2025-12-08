/**
 * Store Module Exports
 *
 * Provides both the main application store (from @phage-explorer/state)
 * and web-specific preferences with localStorage persistence.
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

// Persistence utilities
export {
  initializeStorePersistence,
  hydrateMainStoreFromStorage,
  subscribeMainStoreToStorage,
  syncPreferencesToStorage,
  createWebStore,
} from './createWebStore';
