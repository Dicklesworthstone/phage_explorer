/**
 * useBeginnerMode - Hook for managing beginner mode state
 *
 * This hook provides access to beginner mode features for the educational layer.
 * It's memoized for performance since many components will use it.
 *
 * Part of: phage_explorer-owsv task
 */

import { useCallback, useMemo, useEffect, useState } from 'react';
import {
  usePhageStore,
  useBeginnerModeEnabled,
  useGlossarySidebarOpen,
  useActiveTourId,
  useCompletedModules,
  useCompletedTours,
  initializeBeginnerModeFromStorage,
} from '@phage-explorer/state';

export interface BeginnerModeContext {
  /** Whether beginner mode is currently enabled */
  isEnabled: boolean;
  /** Toggle beginner mode on/off */
  toggle: () => void;
  /** Enable beginner mode */
  enable: () => void;
  /** Disable beginner mode */
  disable: () => void;
  /** Whether the glossary sidebar is open */
  isGlossaryOpen: boolean;
  /** Open the glossary sidebar */
  openGlossary: () => void;
  /** Close the glossary sidebar */
  closeGlossary: () => void;
  /** Show context help for a specific topic */
  showContextFor: (topic: string) => void;
  /** Currently active tour ID (if any) */
  activeTourId: string | null;
  /** Start a guided tour */
  startTour: (tourId: string) => void;
  /** Cancel the active tour without completing it */
  cancelTour: () => void;
  /** Check if a specific tour has been completed */
  hasCompletedTour: (tourId: string) => boolean;
  /** Check if a specific module has been completed */
  hasCompletedModule: (moduleId: string) => boolean;
  /** Mark a tour as completed */
  completeTour: (tourId: string) => void;
  /** Mark a module as completed */
  completeModule: (moduleId: string) => void;
  /** List of all completed tour IDs */
  completedTours: string[];
  /** List of all completed module IDs */
  completedModules: string[];
  /** Reset all beginner mode progress */
  resetProgress: () => void;
}

// Store for active context topic (managed locally, not in global state)
let activeContextTopic: string | null = null;
const contextListeners: Set<(topic: string | null) => void> = new Set();

function notifyContextListeners(topic: string | null) {
  activeContextTopic = topic;
  contextListeners.forEach(listener => listener(topic));
}

/**
 * Hook for subscribing to context topic changes
 */
export function useContextTopic(): string | null {
  const [topic, setTopic] = useState<string | null>(activeContextTopic);

  useEffect(() => {
    const listener = (newTopic: string | null) => setTopic(newTopic);
    contextListeners.add(listener);
    return () => { contextListeners.delete(listener); };
  }, []);

  return topic;
}

/**
 * Main hook for beginner mode functionality
 *
 * Usage:
 * ```tsx
 * const { isEnabled, toggle, showContextFor, hasCompletedTour } = useBeginnerMode();
 *
 * if (isEnabled) {
 *   showContextFor('dna-sequence');
 * }
 * ```
 */
export function useBeginnerMode(): BeginnerModeContext {
  // Get state from store using selectors
  const isEnabled = useBeginnerModeEnabled();
  const isGlossaryOpen = useGlossarySidebarOpen();
  const activeTourId = useActiveTourId();
  const completedTours = useCompletedTours();
  const completedModules = useCompletedModules();

  // Get actions from store
  const toggleBeginnerMode = usePhageStore((s) => s.toggleBeginnerMode);
  const setBeginnerModeEnabled = usePhageStore((s) => s.setBeginnerModeEnabled);
  const openGlossaryAction = usePhageStore((s) => s.openGlossary);
  const closeGlossaryAction = usePhageStore((s) => s.closeGlossary);
  const startTourAction = usePhageStore((s) => s.startTour);
  const cancelTourAction = usePhageStore((s) => s.cancelTour);
  const completeTourAction = usePhageStore((s) => s.completeTour);
  const completeModuleAction = usePhageStore((s) => s.completeModule);
  const resetBeginnerProgress = usePhageStore((s) => s.resetBeginnerProgress);

  // Memoized callbacks
  const toggle = useCallback(() => {
    toggleBeginnerMode();
  }, [toggleBeginnerMode]);

  const enable = useCallback(() => {
    setBeginnerModeEnabled(true);
  }, [setBeginnerModeEnabled]);

  const disable = useCallback(() => {
    setBeginnerModeEnabled(false);
  }, [setBeginnerModeEnabled]);

  const openGlossary = useCallback(() => {
    openGlossaryAction();
  }, [openGlossaryAction]);

  const closeGlossary = useCallback(() => {
    closeGlossaryAction();
  }, [closeGlossaryAction]);

  const showContextFor = useCallback((topic: string) => {
    if (!isEnabled) return;
    notifyContextListeners(topic);
    // Optionally open glossary if it has an entry for this topic
    openGlossaryAction();
  }, [isEnabled, openGlossaryAction]);

  const startTour = useCallback((tourId: string) => {
    startTourAction(tourId);
  }, [startTourAction]);

  const cancelTour = useCallback(() => {
    cancelTourAction();
  }, [cancelTourAction]);

  const hasCompletedTour = useCallback((tourId: string) => {
    return completedTours.includes(tourId);
  }, [completedTours]);

  const hasCompletedModule = useCallback((moduleId: string) => {
    return completedModules.includes(moduleId);
  }, [completedModules]);

  const completeTour = useCallback((tourId: string) => {
    completeTourAction(tourId);
  }, [completeTourAction]);

  const completeModule = useCallback((moduleId: string) => {
    completeModuleAction(moduleId);
  }, [completeModuleAction]);

  const resetProgress = useCallback(() => {
    resetBeginnerProgress();
    notifyContextListeners(null);
  }, [resetBeginnerProgress]);

  // Return memoized context object
  return useMemo(() => ({
    isEnabled,
    toggle,
    enable,
    disable,
    isGlossaryOpen,
    openGlossary,
    closeGlossary,
    showContextFor,
    activeTourId,
    startTour,
    cancelTour,
    hasCompletedTour,
    hasCompletedModule,
    completeTour,
    completeModule,
    completedTours,
    completedModules,
    resetProgress,
  }), [
    isEnabled,
    toggle,
    enable,
    disable,
    isGlossaryOpen,
    openGlossary,
    closeGlossary,
    showContextFor,
    activeTourId,
    startTour,
    cancelTour,
    hasCompletedTour,
    hasCompletedModule,
    completeTour,
    completeModule,
    completedTours,
    completedModules,
    resetProgress,
  ]);
}

/**
 * Hook to initialize beginner mode state from localStorage
 * Call this once at the app root level
 */
export function useBeginnerModeInit(): void {
  const setBeginnerModeEnabled = usePhageStore((s) => s.setBeginnerModeEnabled);
  const completeTour = usePhageStore((s) => s.completeTour);
  const completeModule = usePhageStore((s) => s.completeModule);

  useEffect(() => {
    initializeBeginnerModeFromStorage(
      setBeginnerModeEnabled,
      completeTour,
      completeModule
    );
  }, [setBeginnerModeEnabled, completeTour, completeModule]);
}

export default useBeginnerMode;
