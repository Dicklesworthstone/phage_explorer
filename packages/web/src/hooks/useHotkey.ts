/**
 * useHotkey Hook for Phage Explorer Web
 *
 * React hook for registering keyboard shortcuts.
 */

import { useEffect, useCallback, useState, useRef } from 'react';
import { getKeyboardManager } from '../keyboard/KeyboardManager';
import { ActionRegistry, type ActionId } from '../keyboard/actionRegistry';
import type {
  KeyCombo,
  HotkeyDefinition,
  KeyboardMode,
  KeyboardEvent,
  ExperienceLevel,
} from '../keyboard/types';

function serializeModifiers(modifiers?: KeyCombo['modifiers']): string {
  if (!modifiers) return '';
  const parts: string[] = [];
  if (modifiers.meta) parts.push('meta');
  if (modifiers.ctrl) parts.push('ctrl');
  if (modifiers.alt) parts.push('alt');
  if (modifiers.shift) parts.push('shift');
  return parts.join('+');
}

function serializeKeyCombo(combo: KeyCombo): string {
  const mods = serializeModifiers(combo.modifiers);
  const prefix = mods ? `${mods}+` : '';
  if ('sequence' in combo) {
    return `${prefix}seq:${combo.sequence.join('')}`;
  }
  return `${prefix}${combo.key}`;
}

function serializeCombos(combos: KeyCombo | KeyCombo[]): string {
  const list = Array.isArray(combos) ? combos : [combos];
  return list.map(serializeKeyCombo).join('|');
}

function serializeModes(modes?: ReadonlyArray<KeyboardMode>): string {
  return modes ? modes.join('|') : '';
}

/**
 * Register a single hotkey
 *
 * @example
 * useHotkey(ActionIds.ViewCycleTheme, nextTheme);
 * useHotkey(ActionIds.OverlayHelp, () => openOverlay('help'));
 * useHotkey(ActionIds.NavScrollStart, goToTop, { combo: { sequence: ['g', 'g'] } });
 * useHotkey(ActionIds.AnalysisAdvancedFeature, doAdvanced, { minLevel: 'power' });
 */
export function useHotkey(
  actionId: ActionId,
  action: () => void | Promise<void>,
  options?: {
    combo?: KeyCombo | KeyCombo[];
    description?: string;
    category?: string;
    modes?: ReadonlyArray<KeyboardMode>;
    priority?: number;
    minLevel?: ExperienceLevel;  // Minimum experience level to activate (default: novice)
    allowInInput?: boolean;      // Allow triggering while typing in inputs/contenteditable
    enabled?: boolean;           // Opt-out of registration when false
  }
): void {
  const actionRef = useRef(action);
  const actionMeta = ActionRegistry[actionId];
  const combos = options?.combo ?? actionMeta.defaultShortcut;
  const description = options?.description ?? actionMeta.title;
  const category = options?.category ?? actionMeta.category;
  const minLevel = options?.minLevel ?? actionMeta.minLevel;
  const registrationKey = [
    actionId,
    serializeCombos(combos),
    description,
    category,
    serializeModes(options?.modes),
    options?.priority ?? '',
    minLevel ?? '',
    options?.allowInInput ?? '',
  ].join('::');

  useEffect(() => {
    actionRef.current = action;
  }, [action]);

  const stableAction = useCallback(() => {
    return actionRef.current();
  }, []);

  useEffect(() => {
    if (options?.enabled === false) {
      return;
    }
    const manager = getKeyboardManager();
    const registrations = buildHotkeyDefinitions({
      actionId,
      action: stableAction,
      combo: combos,
      description,
      category,
      modes: options?.modes,
      priority: options?.priority,
      minLevel,
      allowInInput: options?.allowInInput,
    });
    const unregister = manager.registerMany(registrations);

    return unregister;
  }, [stableAction, registrationKey, options?.enabled]);
}

/**
 * Register multiple hotkeys at once
 *
 * @example
 * useHotkeys([
 *   { actionId: ActionIds.NavNextPhage, action: moveDown },
 *   { actionId: ActionIds.NavPrevPhage, action: moveUp },
 * ]);
 */
export function useHotkeys(definitions: HotkeyRegistration[]): void {
  useEffect(() => {
    const manager = getKeyboardManager();
    const activeDefinitions = definitions.filter((definition) => definition.enabled !== false);
    if (activeDefinitions.length === 0) {
      return;
    }
    const registrations = activeDefinitions.flatMap((definition) => buildHotkeyDefinitions(definition));
    const unregister = manager.registerMany(registrations);
    return unregister;
  }, [definitions]);
}

interface HotkeyRegistration {
  actionId: ActionId;
  action: () => void | Promise<void>;
  combo?: KeyCombo | KeyCombo[];
  description?: string;
  category?: string;
  modes?: ReadonlyArray<KeyboardMode>;
  priority?: number;
  minLevel?: ExperienceLevel;
  allowInInput?: boolean;
  enabled?: boolean;
}

function buildHotkeyDefinitions(definition: HotkeyRegistration): HotkeyDefinition[] {
  const actionMeta = ActionRegistry[definition.actionId];
  const combos = definition.combo ?? actionMeta.defaultShortcut;
  const comboList = Array.isArray(combos) ? combos : [combos];
  const description = definition.description ?? actionMeta.title;
  const category = definition.category ?? actionMeta.category;
  const minLevel = definition.minLevel ?? actionMeta.minLevel;

  return comboList.map((combo): HotkeyDefinition => ({
    actionId: definition.actionId,
    combo,
    description,
    action: definition.action,
    modes: definition.modes,
    category,
    priority: definition.priority,
    minLevel,
    allowInInput: definition.allowInInput,
  }));
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
  const [mode, setModeState] = useState<KeyboardMode>(() => manager.getMode());

  useEffect(() => {
    const unsubscribe = manager.subscribe((event) => {
      if (event.type === 'mode_change') {
        setModeState(event.mode);
      }
    });

    return () => {
      unsubscribe();
    };
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
  const [pending, setPending] = useState<string | null>(() => manager.getPendingSequence());

  useEffect(() => {
    const unsubscribe = manager.subscribe((event) => {
      if (event.type === 'sequence_started') {
        setPending(event.key);
      } else if (event.type === 'sequence_completed' || event.type === 'sequence_cancelled') {
        setPending(null);
      }
    });

    return () => {
      unsubscribe();
    };
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
    const unsubscribe = manager.subscribe(listener);
    return () => {
      unsubscribe();
    };
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
