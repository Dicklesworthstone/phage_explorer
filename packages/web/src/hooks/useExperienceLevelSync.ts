/**
 * Experience Level Sync Hook
 *
 * Syncs the experience level from the store to the KeyboardManager
 * and handles blocked hotkey notifications.
 */

import { useEffect, useState, useCallback } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { getKeyboardManager } from '../keyboard/KeyboardManager';
import type { ExperienceLevel, KeyboardEvent } from '../keyboard/types';
import { formatKeyCombo } from '../keyboard/types';

export interface BlockedHotkeyInfo {
  description: string;
  keyDisplay: string;
  requiredLevel: ExperienceLevel;
  currentLevel: ExperienceLevel;
}

/**
 * Sync experience level from store to KeyboardManager.
 * Returns the current experience level.
 */
export function useExperienceLevelSync(): ExperienceLevel {
  const experienceLevel = usePhageStore((s) => s.experienceLevel) as ExperienceLevel;

  useEffect(() => {
    const manager = getKeyboardManager();
    manager.setExperienceLevel(experienceLevel);
  }, [experienceLevel]);

  return experienceLevel;
}

/**
 * Listen for blocked hotkey events and provide notification state.
 * Shows a gentle explanation when a user tries to use a gated hotkey.
 */
export function useBlockedHotkeyNotification(): {
  blockedHotkey: BlockedHotkeyInfo | null;
  dismiss: () => void;
} {
  const [blockedHotkey, setBlockedHotkey] = useState<BlockedHotkeyInfo | null>(null);

  const dismiss = useCallback(() => {
    setBlockedHotkey(null);
  }, []);

  useEffect(() => {
    const manager = getKeyboardManager();

    const handleEvent = (event: KeyboardEvent) => {
      if (event.type === 'hotkey_blocked') {
        setBlockedHotkey({
          description: event.description,
          keyDisplay: formatKeyCombo(event.combo),
          requiredLevel: event.requiredLevel,
          currentLevel: event.currentLevel,
        });
      }
    };

    const unsubscribe = manager.subscribe(handleEvent);
    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (!blockedHotkey) return;
    const timer = setTimeout(() => {
      setBlockedHotkey(null);
    }, 4000);

    return () => {
      clearTimeout(timer);
    };
  }, [blockedHotkey]);

  return { blockedHotkey, dismiss };
}

/**
 * Get a friendly label for an experience level
 */
export function getExperienceLevelLabel(level: ExperienceLevel): string {
  switch (level) {
    case 'novice':
      return 'Novice';
    case 'intermediate':
      return 'Intermediate';
    case 'power':
      return 'Power User';
    default:
      return level;
  }
}

/**
 * Get the next experience level (for upgrading)
 */
export function getNextExperienceLevel(current: ExperienceLevel): ExperienceLevel | null {
  const levels: ExperienceLevel[] = ['novice', 'intermediate', 'power'];
  const currentIndex = levels.indexOf(current);
  if (currentIndex < levels.length - 1) {
    return levels[currentIndex + 1];
  }
  return null;
}
