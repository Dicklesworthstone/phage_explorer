/**
 * Web-specific Zustand Store with Persistence
 *
 * Wraps the core Phage Explorer store with browser localStorage persistence.
 * Only persists user preferences, not runtime data.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Theme } from '@phage-explorer/core';
import { CLASSIC_THEME, getThemeById } from '@phage-explorer/core';
import type {
  PhageExplorerState,
  PhageExplorerActions,
  PhageExplorerStore,
  HelpDetailLevel,
  ExperienceLevel,
} from '@phage-explorer/state';

// Version for migration logic
const STORE_VERSION = 1;

// Keys to persist (user preferences only)
type PersistedKeys =
  | 'currentTheme'
  | 'viewMode'
  | 'readingFrame'
  | 'model3DQuality'
  | 'helpDetail'
  | 'experienceLevel'
  | 'hasSeenWelcome'
  | 'scanlines'
  | 'glow'
  | 'tuiMode';

type PersistedState = Pick<PhageExplorerState, Exclude<PersistedKeys, 'hasSeenWelcome' | 'scanlines' | 'glow' | 'tuiMode'>> & {
  hasSeenWelcome: boolean;
  scanlines: boolean;
  glow: boolean;
  tuiMode: boolean;
};

/**
 * Default preferences
 */
const defaultPreferences: PersistedState = {
  currentTheme: CLASSIC_THEME,
  viewMode: 'dna',
  readingFrame: 0,
  model3DQuality: 'medium',
  helpDetail: 'essential',
  experienceLevel: 'novice',
  hasSeenWelcome: false,
  scanlines: true,
  glow: true,
  tuiMode: false,
};

/**
 * Migrate state from older versions
 */
function migrateState(
  persistedState: unknown,
  version: number
): PersistedState {
  const state = persistedState as Partial<PersistedState>;
  
  if (version === 0) {
    // Version 0 -> 1: Added experienceLevel
    return {
      ...defaultPreferences,
      ...state,
      experienceLevel: state.experienceLevel ?? 'novice',
      hasSeenWelcome: state.hasSeenWelcome ?? false,
      scanlines: state.scanlines ?? true,
      glow: state.glow ?? true,
      tuiMode: state.tuiMode ?? false,
    };
  }

  // Ensure new keys are present for any version
  return {
    ...defaultPreferences,
    ...state,
  };
}

/**
 * Create the web store with persistence
 */
export function createWebStore() {
  // Re-export the core store creator
  // In a real implementation, we'd import the core store and wrap it
  // For now, creating a minimal preference store for web-specific persistence
  return create<PersistedState & {
    setTheme: (themeId: string) => void;
    setExperienceLevel: (level: ExperienceLevel) => void;
    setHelpDetail: (level: HelpDetailLevel) => void;
    setHasSeenWelcome: (seen: boolean) => void;
    setScanlines: (enabled: boolean) => void;
    setGlow: (enabled: boolean) => void;
    setTuiMode: (enabled: boolean) => void;
    commandHistory: Array<{ label: string; at: number }>;
    pushCommand: (label: string) => void;
    clearHistory: () => void;
  }>()(
    persist(
      (set) => ({
        ...defaultPreferences,
        commandHistory: [],

        setTheme: (themeId) => set({ currentTheme: getThemeById(themeId) }),
        setExperienceLevel: (level) => set({ experienceLevel: level }),
        setHelpDetail: (level) => set({ helpDetail: level }),
        setHasSeenWelcome: (seen) => set({ hasSeenWelcome: seen }),
        setScanlines: (enabled) => set({ scanlines: enabled }),
        setGlow: (enabled) => set({ glow: enabled }),
        setTuiMode: (enabled) => set({ tuiMode: enabled }),
        pushCommand: (label) => set((state) => {
          const next = [{ label, at: Date.now() }, ...state.commandHistory].slice(0, 20);
          return { commandHistory: next };
        }),
        clearHistory: () => set({ commandHistory: [] }),
      }),
      {
        name: 'phage-explorer-preferences',
        version: STORE_VERSION,
        storage: createJSONStorage(() => localStorage),
        partialize: (state) => ({
          currentTheme: state.currentTheme,
          viewMode: state.viewMode,
          readingFrame: state.readingFrame,
          model3DQuality: state.model3DQuality,
          helpDetail: state.helpDetail,
          experienceLevel: state.experienceLevel,
          hasSeenWelcome: state.hasSeenWelcome,
          scanlines: state.scanlines,
          glow: state.glow,
          tuiMode: state.tuiMode,
          // commandHistory intentionally not persisted
        }),
        migrate: migrateState,
        onRehydrateStorage: () => (state) => {
          if (state) {
            console.log('[Store] Preferences loaded from localStorage');
          }
        },
      }
    )
  );
}

/**
 * Hook to get persisted preferences
 */
export const useWebPreferences = createWebStore();

/**
 * Sync preferences back to localStorage on change
 */
export function syncPreferencesToStorage(state: Partial<PersistedState>): void {
  const current = useWebPreferences.getState();
  useWebPreferences.setState({ ...current, ...state });
}

export default createWebStore;
