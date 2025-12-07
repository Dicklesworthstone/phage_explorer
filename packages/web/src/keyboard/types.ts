/**
 * Keyboard Manager Type Definitions
 *
 * Vim-inspired modal keyboard system for Phage Explorer Web.
 */

/**
 * Keyboard modes (vim-inspired)
 */
export type KeyboardMode = 'NORMAL' | 'SEARCH' | 'COMMAND' | 'VISUAL' | 'INSERT';

/**
 * Modifier keys
 */
export interface ModifierState {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;  // Command on Mac, Windows key on Windows
}

/**
 * Key combination descriptor
 */
export interface KeyCombo {
  key: string;           // The key (e.g., 'g', 'Enter', 'Escape')
  modifiers?: Partial<ModifierState>;
  sequence?: string[];   // For multi-key sequences like 'gg'
}

/**
 * Hotkey definition
 */
export interface HotkeyDefinition {
  combo: KeyCombo;
  description: string;
  modes?: KeyboardMode[];  // Which modes this hotkey is active in (default: all)
  action: () => void | Promise<void>;
  category?: string;       // For grouping in help overlay
  priority?: number;       // Higher priority wins on conflict (default: 0)
}

/**
 * Key sequence buffer for multi-key commands
 */
export interface SequenceBuffer {
  keys: string[];
  timestamp: number;
}

/**
 * Keyboard event handler options
 */
export interface KeyboardHandlerOptions {
  preventDefault?: boolean;
  stopPropagation?: boolean;
  allowInInput?: boolean;  // Whether to trigger in input/textarea elements
}

/**
 * Keyboard manager state
 */
export interface KeyboardState {
  mode: KeyboardMode;
  sequenceBuffer: SequenceBuffer;
  isActive: boolean;
  pendingSequence: string | null;  // For displaying 'g' when waiting for second key
}

/**
 * Keyboard manager events
 */
export type KeyboardEvent =
  | { type: 'mode_change'; mode: KeyboardMode; previousMode: KeyboardMode }
  | { type: 'hotkey_triggered'; combo: KeyCombo; description: string }
  | { type: 'sequence_started'; key: string }
  | { type: 'sequence_completed'; sequence: string[] }
  | { type: 'sequence_cancelled' };

/**
 * Keyboard event listener
 */
export type KeyboardEventListener = (event: KeyboardEvent) => void;

/**
 * Common key codes
 */
export const Keys = {
  // Special keys
  ESCAPE: 'Escape',
  ENTER: 'Enter',
  TAB: 'Tab',
  SPACE: ' ',
  BACKSPACE: 'Backspace',
  DELETE: 'Delete',

  // Arrow keys
  UP: 'ArrowUp',
  DOWN: 'ArrowDown',
  LEFT: 'ArrowLeft',
  RIGHT: 'ArrowRight',

  // Navigation
  HOME: 'Home',
  END: 'End',
  PAGE_UP: 'PageUp',
  PAGE_DOWN: 'PageDown',

  // Function keys
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
} as const;

/**
 * Default hotkey categories
 */
export const HotkeyCategories = {
  NAVIGATION: 'Navigation',
  SEARCH: 'Search',
  THEMES: 'Themes',
  OVERLAYS: 'Overlays',
  ANALYSIS: 'Analysis',
  SIMULATION: 'Simulation',
  GENERAL: 'General',
} as const;

/**
 * Format a key combo for display
 */
export function formatKeyCombo(combo: KeyCombo): string {
  const parts: string[] = [];

  if (combo.modifiers?.meta) parts.push('⌘');
  if (combo.modifiers?.ctrl) parts.push('Ctrl');
  if (combo.modifiers?.alt) parts.push('Alt');
  if (combo.modifiers?.shift) parts.push('Shift');

  if (combo.sequence) {
    parts.push(combo.sequence.join(''));
  } else {
    // Format special keys nicely
    let keyDisplay = combo.key;
    if (combo.key === ' ') keyDisplay = 'Space';
    if (combo.key === 'Escape') keyDisplay = 'Esc';
    if (combo.key === 'ArrowUp') keyDisplay = '↑';
    if (combo.key === 'ArrowDown') keyDisplay = '↓';
    if (combo.key === 'ArrowLeft') keyDisplay = '←';
    if (combo.key === 'ArrowRight') keyDisplay = '→';
    parts.push(keyDisplay);
  }

  return parts.join('+');
}
