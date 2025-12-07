/**
 * useHotkey Hook for Phage Explorer Web
 *
 * React hook for registering keyboard shortcuts.
 */

import { useEffect, useCallback, useState } from 'react';
import { getKeyboardManager } from '../keyboard/KeyboardManager';
import type {
  KeyCombo,
  HotkeyDefinition,
  KeyboardMode,
  KeyboardEvent,
} from '../keyboard/types';

/**
 * Register a single hotkey
 *
 * @example
 * useHotkey({ key: 't' }, 'Cycle theme', nextTheme);
 * useHotkey({ key: '?', modifiers: { shift: true } }, 'Show help', showHelp);
 * useHotkey({ sequence: ['g', 'g'] }, 'Go to top', goToTop);
 */
export function useHotkey(
  combo: KeyCombo,
  description: string,
  action: () => void | Promise<void>,
  options?: {
    modes?: KeyboardMode[];
    category?: string;
    priority?: number;
  }
): void {
  useEffect(() => {
    const manager = getKeyboardManager();
    const unregister = manager.register({
      combo,
      description,
      action,
      modes: options?.modes,
      category: options?.category,
      priority: options?.priority,
    });

    return unregister;
  }, [combo, description, action, options?.modes, options?.category, options?.priority]);
}

/**
 * Register multiple hotkeys at once
 *
 * @example
 * useHotkeys([
 *   { combo: { key: 'j' }, description: 'Move down', action: moveDown },
 *   { combo: { key: 'k' }, description: 'Move up', action: moveUp },
 * ]);
 */
export function useHotkeys(definitions: HotkeyDefinition[]): void {
  useEffect(() => {
    const manager = getKeyboardManager();
    const unregister = manager.registerMany(definitions);
    return unregister;
  }, [definitions]);
}

/**
 * Get the current keyboard mode
 *
 * @example
 * const { mode, setMode } = useKeyboardMode();
 * // mode is 'NORMAL', 'SEARCH', 'COMMAND', 'VISUAL', or 'INSERT'
 */
export function useKeyboardMode(): {
  mode: KeyboardMode;
  setMode: (mode: KeyboardMode) => void;
} {
  const manager = getKeyboardManager();
  const [mode, setModeState] = useState<KeyboardMode>(manager.getMode());

  useEffect(() => {
    const unsubscribe = manager.addEventListener((event) => {
      if (event.type === 'mode_change') {
        setModeState(event.mode);
      }
    });

    return unsubscribe;
  }, [manager]);

  const setMode = useCallback(
    (newMode: KeyboardMode) => {
      manager.setMode(newMode);
    },
    [manager]
  );

  return { mode, setMode };
}

/**
 * Get the pending key sequence (for display)
 *
 * @example
 * const pendingSequence = usePendingSequence();
 * // pendingSequence is 'g' when waiting for second key of 'gg'
 */
export function usePendingSequence(): string | null {
  const manager = getKeyboardManager();
  const [pending, setPending] = useState<string | null>(manager.getPendingSequence());

  useEffect(() => {
    const unsubscribe = manager.addEventListener((event) => {
      if (event.type === 'sequence_started') {
        setPending(event.key);
      } else if (event.type === 'sequence_completed' || event.type === 'sequence_cancelled') {
        setPending(null);
      }
    });

    return unsubscribe;
  }, [manager]);

  return pending;
}

/**
 * Subscribe to keyboard events
 *
 * @example
 * useKeyboardEvents((event) => {
 *   if (event.type === 'hotkey_triggered') {
 *     console.log('Triggered:', event.description);
 *   }
 * });
 */
export function useKeyboardEvents(listener: (event: KeyboardEvent) => void): void {
  useEffect(() => {
    const manager = getKeyboardManager();
    const unsubscribe = manager.addEventListener(listener);
    return unsubscribe;
  }, [listener]);
}

/**
 * Get all registered hotkeys
 *
 * @example
 * const hotkeys = useAllHotkeys();
 * // Map of category -> definitions
 */
export function useAllHotkeys(): Map<string, HotkeyDefinition[]> {
  const manager = getKeyboardManager();
  return manager.getHotkeysByCategory();
}

/**
 * Enable/disable the keyboard manager
 *
 * Useful for disabling hotkeys when a modal is open.
 *
 * @example
 * useKeyboardActive(false); // Disable keyboard while modal is open
 */
export function useKeyboardActive(active: boolean): void {
  useEffect(() => {
    const manager = getKeyboardManager();
    manager.setActive(active);
    return () => manager.setActive(true); // Re-enable on unmount
  }, [active]);
}

export default useHotkey;
