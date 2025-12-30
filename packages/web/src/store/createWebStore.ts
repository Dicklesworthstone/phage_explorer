/**
 * Web-specific Zustand Store with Persistence
 *
 * Integrates the core @phage-explorer/state store with browser localStorage
 * persistence for user preferences. The main store handles all app state,
 * while this module adds persistence for preferences that should survive
 * browser sessions.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { Theme, ViewMode, ReadingFrame } from '@phage-explorer/core';
import {
  usePhageStore,
  type HelpDetailLevel,
  type ExperienceLevel,
} from '@phage-explorer/state';

// Re-export the main store for convenience
export { usePhageStore } from '@phage-explorer/state';
export type { PhageExplorerStore, PhageExplorerState, PhageExplorerActions } from '@phage-explorer/state';

// Version for migration logic
const STORE_VERSION = 6;

function getDefaultBackgroundEffects(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  const coarseTouch = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  // Default to off on touch devices to avoid scroll jank/flicker; users can re-enable in Settings.
  return !coarseTouch;
}

/**
 * Web-specific preferences that persist to localStorage
 * These augment the main store with browser-specific state
 */
export interface WebPreferencesState {
  // Persisted preferences
  hasSeenWelcome: boolean;
  hasLearnedMobileSwipe: boolean;
  scanlines: boolean;
  scanlineIntensity: number;
  glow: boolean;
  tuiMode: boolean;
  highContrast: boolean;
  backgroundEffects: boolean;
  // Control palette state
  controlDrawerOpen: boolean;
  // Command history (session only, not persisted)
  commandHistory: Array<{ label: string; at: number }>;
  // Hydration state
  _hasHydrated: boolean;
}

export interface WebPreferencesActions {
  setHasSeenWelcome: (seen: boolean) => void;
  setHasLearnedMobileSwipe: (learned: boolean) => void;
  setScanlines: (enabled: boolean) => void;
  setScanlineIntensity: (intensity: number) => void;
  setGlow: (enabled: boolean) => void;
  setTuiMode: (enabled: boolean) => void;
  setHighContrast: (enabled: boolean) => void;
  setBackgroundEffects: (enabled: boolean) => void;
  setControlDrawerOpen: (open: boolean) => void;
  toggleControlDrawer: () => void;
  pushCommand: (label: string) => void;
  clearHistory: () => void;
  setHasHydrated: (state: boolean) => void;
}

export type WebPreferencesStore = WebPreferencesState & WebPreferencesActions;

interface PersistedMainState {
  themeId?: string; // Preferred
  currentTheme?: Theme; // Legacy
  viewMode: ViewMode;
  readingFrame: ReadingFrame;
  show3DModel: boolean;
  model3DQuality: 'low' | 'medium' | 'high' | 'ultra';
  helpDetail: HelpDetailLevel;
  experienceLevel: ExperienceLevel;
}

/**
 * Default web preferences
 */
const defaultWebPreferences: WebPreferencesState = {
  hasSeenWelcome: false,
  hasLearnedMobileSwipe: false,
  scanlines: false,
  scanlineIntensity: 0.06,
  glow: true,
  tuiMode: false,
  highContrast: false,
  backgroundEffects: getDefaultBackgroundEffects(),
  controlDrawerOpen: false,
  commandHistory: [],
  _hasHydrated: false,
};

/**
 * Migrate persisted state from older versions
 */
function migrateWebPrefs(
  persistedState: unknown,
  version: number
): WebPreferencesState {
  const state = persistedState as Partial<WebPreferencesState>;

  if (version < 2) {
    // Version 1 -> 2: Separated web prefs from main store prefs, added scanlineIntensity
    return {
      ...defaultWebPreferences,
      hasSeenWelcome: state.hasSeenWelcome ?? false,
      scanlines: state.scanlines ?? false,
      scanlineIntensity: Math.min(state.scanlineIntensity ?? 0.06, 0.08),
      glow: state.glow ?? true,
      tuiMode: state.tuiMode ?? false,
      highContrast: state.highContrast ?? false,
    };
  }

  if (version < 3) {
    // Version 2 -> 3: Add highContrast toggle
    return {
      ...defaultWebPreferences,
      ...state,
      highContrast: state.highContrast ?? false,
    };
  }

  if (version < 4) {
    // Version 3 -> 4: Add backgroundEffects toggle
    return {
      ...defaultWebPreferences,
      ...state,
      scanlineIntensity: Math.min(state.scanlineIntensity ?? 0.06, 0.08),
      backgroundEffects: state.backgroundEffects ?? defaultWebPreferences.backgroundEffects,
      _hasHydrated: false,
    };
  }

  if (version < 5) {
    // Version 4 -> 5: Add hasLearnedMobileSwipe for progressive disclosure
    return {
      ...defaultWebPreferences,
      ...state,
      scanlineIntensity: Math.min(state.scanlineIntensity ?? 0.06, 0.08),
      backgroundEffects: state.backgroundEffects ?? defaultWebPreferences.backgroundEffects,
      hasLearnedMobileSwipe: false, // New users haven't learned yet
      _hasHydrated: false,
    };
  }

  if (version < 6) {
    return {
      ...defaultWebPreferences,
      ...state,
      scanlines: false,
      scanlineIntensity: Math.min(state.scanlineIntensity ?? 0.06, 0.08),
      backgroundEffects: state.backgroundEffects ?? defaultWebPreferences.backgroundEffects,
      hasLearnedMobileSwipe: state.hasLearnedMobileSwipe ?? false,
      _hasHydrated: false,
    };
  }

  return {
    ...defaultWebPreferences,
    ...state,
    scanlineIntensity: Math.min(state.scanlineIntensity ?? 0.06, 0.08),
    backgroundEffects: state.backgroundEffects ?? defaultWebPreferences.backgroundEffects,
    hasLearnedMobileSwipe: state.hasLearnedMobileSwipe ?? false,
    _hasHydrated: false, // Always reset hydration on load
  };
}

/**
 * Web preferences store (web-specific state with persistence)
 */
export const useWebPreferences = create<WebPreferencesStore>()(
  persist(
    (set) => ({
      ...defaultWebPreferences,

      setHasSeenWelcome: (seen) => set({ hasSeenWelcome: seen }),
      setHasLearnedMobileSwipe: (learned) => set({ hasLearnedMobileSwipe: learned }),
      setScanlines: (enabled) => set({ scanlines: enabled }),
      setScanlineIntensity: (intensity) => set({ scanlineIntensity: intensity }),
      setGlow: (enabled) => set({ glow: enabled }),
      setTuiMode: (enabled) => set({ tuiMode: enabled }),
      setHighContrast: (enabled) => set({ highContrast: enabled }),
      setBackgroundEffects: (enabled) => set({ backgroundEffects: enabled }),
      setControlDrawerOpen: (open) => set({ controlDrawerOpen: open }),
      toggleControlDrawer: () =>
        set((state) => ({ controlDrawerOpen: !state.controlDrawerOpen })),
      pushCommand: (label) =>
        set((state) => ({
          commandHistory: [
            { label, at: Date.now() },
            ...state.commandHistory,
          ].slice(0, 20),
        })),
      clearHistory: () => set({ commandHistory: [] }),
      setHasHydrated: (hydrated) => set({ _hasHydrated: hydrated }),
    }),
    {
      name: 'phage-explorer-web-prefs',
      version: STORE_VERSION,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        hasSeenWelcome: state.hasSeenWelcome,
        hasLearnedMobileSwipe: state.hasLearnedMobileSwipe,
        scanlines: state.scanlines,
        scanlineIntensity: state.scanlineIntensity,
        glow: state.glow,
        tuiMode: state.tuiMode,
        highContrast: state.highContrast,
        backgroundEffects: state.backgroundEffects,
        controlDrawerOpen: state.controlDrawerOpen,
        // commandHistory intentionally not persisted
      }),
      migrate: migrateWebPrefs,
      onRehydrateStorage: () => (state) => {
        if (state) {
          state.setHasHydrated(true);
        }
      },
    }
  )
);

/**
 * Load persisted main store preferences from localStorage
 * Call this once on app initialization to hydrate the main store
 */
export function hydrateMainStoreFromStorage(): void {
  const STORAGE_KEY = 'phage-explorer-main-prefs';

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;

    const parsed = JSON.parse(stored) as Partial<PersistedMainState>;
    const store = usePhageStore.getState();

    // Apply persisted preferences to main store
    if (parsed.themeId) {
      store.setTheme(parsed.themeId);
    } else if (parsed.currentTheme?.id) {
      store.setTheme(parsed.currentTheme.id);
    }
    if (parsed.viewMode) {
      store.setViewMode(parsed.viewMode);
    }
    if (typeof parsed.readingFrame === 'number') {
      store.setReadingFrame(parsed.readingFrame);
    }
    if (typeof parsed.show3DModel === 'boolean') {
      usePhageStore.setState({ show3DModel: parsed.show3DModel });
    }
    if (parsed.helpDetail) {
      store.setHelpDetail(parsed.helpDetail);
    }
    if (parsed.experienceLevel) {
      store.setExperienceLevel(parsed.experienceLevel);
    }
    // model3DQuality doesn't have a setter in main store, handled internally

  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn('[Store] Failed to hydrate main store:', error);
    }
  }
}

/**
 * Subscribe to main store changes and persist preferences
 * Call this once on app initialization
 */
export function subscribeMainStoreToStorage(): () => void {
  const STORAGE_KEY = 'phage-explorer-main-prefs';

  // Debounce writes to avoid excessive localStorage updates
  let writeTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastPrefs = '';

  const unsubscribe = usePhageStore.subscribe((state) => {
    // Guard against uninitialized state
    if (!state.currentTheme) return;

    const prefs = {
      themeId: state.currentTheme.id,
      viewMode: state.viewMode,
      readingFrame: state.readingFrame,
      show3DModel: state.show3DModel,
      model3DQuality: state.model3DQuality,
      helpDetail: state.helpDetail,
      experienceLevel: state.experienceLevel,
    };

    const prefsJson = JSON.stringify(prefs);
    if (prefsJson === lastPrefs) return;
    lastPrefs = prefsJson;

    if (writeTimeout) {
      clearTimeout(writeTimeout);
    }
    writeTimeout = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, prefsJson);
      } catch (error) {
        if (import.meta.env.DEV) {
          console.warn('[Store] Failed to persist main store:', error);
        }
      }
    }, 500); // Debounce 500ms
  });

  return () => {
    unsubscribe();
    if (writeTimeout) {
      clearTimeout(writeTimeout);
    }
  };
}

/**
 * Initialize store persistence (call once at app startup)
 * Returns cleanup function
 */
export function initializeStorePersistence(): () => void {
  hydrateMainStoreFromStorage();
  return subscribeMainStoreToStorage();
}

/**
 * Sync preferences back to localStorage (for backwards compatibility)
 */
export function syncPreferencesToStorage(
  state: Partial<WebPreferencesState>
): void {
  const current = useWebPreferences.getState();
  useWebPreferences.setState({ ...current, ...state });
}

// Legacy export for backwards compatibility
export function createWebStore() {
  return useWebPreferences;
}

export default createWebStore;
