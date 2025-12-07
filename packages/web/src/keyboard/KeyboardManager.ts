/**
 * Keyboard Manager for Phage Explorer Web
 *
 * A vim-inspired keyboard manager with modal states and key sequences.
 */

import type {
  KeyboardMode,
  ModifierState,
  KeyCombo,
  HotkeyDefinition,
  SequenceBuffer,
  KeyboardState,
  KeyboardEvent,
  KeyboardEventListener,
  KeyboardHandlerOptions,
} from './types';

const SEQUENCE_TIMEOUT = 1000; // 1 second to complete a sequence

/**
 * Check if an element is an input element
 */
function isInputElement(element: Element | null): boolean {
  if (!element) return false;
  const tagName = element.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    (element as HTMLElement).isContentEditable
  );
}

/**
 * Extract modifiers from a keyboard event
 */
function getModifiers(event: globalThis.KeyboardEvent): ModifierState {
  return {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
  };
}

/**
 * Check if modifiers match
 */
function modifiersMatch(
  eventMods: ModifierState,
  comboMods?: Partial<ModifierState>
): boolean {
  if (!comboMods) {
    // No modifiers specified means we want no modifiers pressed
    return !eventMods.ctrl && !eventMods.alt && !eventMods.meta;
  }

  return (
    (comboMods.ctrl ?? false) === eventMods.ctrl &&
    (comboMods.alt ?? false) === eventMods.alt &&
    (comboMods.shift ?? false) === eventMods.shift &&
    (comboMods.meta ?? false) === eventMods.meta
  );
}

/**
 * Keyboard Manager
 *
 * Provides vim-style modal keyboard handling with support for:
 * - Multiple keyboard modes (NORMAL, SEARCH, COMMAND, VISUAL, INSERT)
 * - Key sequences (e.g., 'gg' for go to top)
 * - Modifier combinations (Ctrl+Shift+P)
 * - Priority-based hotkey resolution
 */
export class KeyboardManager {
  private state: KeyboardState;
  private hotkeys: Map<string, HotkeyDefinition[]>;
  private listeners: Set<KeyboardEventListener>;
  private boundHandler: (e: globalThis.KeyboardEvent) => void;
  private sequenceTimeoutId: number | null = null;

  constructor() {
    this.state = {
      mode: 'NORMAL',
      sequenceBuffer: { keys: [], timestamp: 0 },
      isActive: true,
      pendingSequence: null,
    };
    this.hotkeys = new Map();
    this.listeners = new Set();
    this.boundHandler = this.handleKeyDown.bind(this);
  }

  /**
   * Initialize the keyboard manager
   */
  init(): void {
    window.addEventListener('keydown', this.boundHandler, { capture: true });
  }

  /**
   * Clean up the keyboard manager
   */
  destroy(): void {
    window.removeEventListener('keydown', this.boundHandler, { capture: true });
    if (this.sequenceTimeoutId) {
      window.clearTimeout(this.sequenceTimeoutId);
    }
  }

  /**
   * Get current keyboard mode
   */
  getMode(): KeyboardMode {
    return this.state.mode;
  }

  /**
   * Set keyboard mode
   */
  setMode(mode: KeyboardMode): void {
    const previousMode = this.state.mode;
    if (mode !== previousMode) {
      this.state.mode = mode;
      this.clearSequence();
      this.emit({ type: 'mode_change', mode, previousMode });
    }
  }

  /**
   * Get pending sequence (for display)
   */
  getPendingSequence(): string | null {
    return this.state.pendingSequence;
  }

  /**
   * Enable/disable keyboard manager
   */
  setActive(active: boolean): void {
    this.state.isActive = active;
  }

  /**
   * Check if keyboard manager is active
   */
  isActive(): boolean {
    return this.state.isActive;
  }

  /**
   * Register a hotkey
   */
  register(definition: HotkeyDefinition): () => void {
    const key = this.getHotkeyKey(definition.combo);
    const existing = this.hotkeys.get(key) ?? [];
    existing.push(definition);
    // Sort by priority (higher first)
    existing.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    this.hotkeys.set(key, existing);

    // Return unregister function
    return () => {
      const defs = this.hotkeys.get(key);
      if (defs) {
        const index = defs.indexOf(definition);
        if (index !== -1) {
          defs.splice(index, 1);
          if (defs.length === 0) {
            this.hotkeys.delete(key);
          }
        }
      }
    };
  }

  /**
   * Register multiple hotkeys
   */
  registerMany(definitions: HotkeyDefinition[]): () => void {
    const unregisters = definitions.map((d) => this.register(d));
    return () => unregisters.forEach((u) => u());
  }

  /**
   * Add event listener
   */
  addEventListener(listener: KeyboardEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Get all registered hotkeys
   */
  getAllHotkeys(): HotkeyDefinition[] {
    const all: HotkeyDefinition[] = [];
    for (const defs of this.hotkeys.values()) {
      all.push(...defs);
    }
    return all;
  }

  /**
   * Get hotkeys by category
   */
  getHotkeysByCategory(): Map<string, HotkeyDefinition[]> {
    const byCategory = new Map<string, HotkeyDefinition[]>();
    for (const def of this.getAllHotkeys()) {
      const category = def.category ?? 'General';
      const existing = byCategory.get(category) ?? [];
      existing.push(def);
      byCategory.set(category, existing);
    }
    return byCategory;
  }

  /**
   * Handle keydown event
   */
  private handleKeyDown(event: globalThis.KeyboardEvent): void {
    if (!this.state.isActive) return;

    // Skip if in input element unless explicitly allowed
    if (isInputElement(event.target as Element)) {
      // Only process Escape in input elements
      if (event.key !== 'Escape') return;
    }

    const modifiers = getModifiers(event);
    const key = event.key;

    // Check for sequence match first
    if (this.trySequence(key, modifiers, event)) {
      return;
    }

    // Check for direct hotkey match
    if (this.tryHotkey(key, modifiers, event)) {
      return;
    }

    // Start a new sequence if this key could be the start of one
    this.startSequenceIfPossible(key, modifiers, event);
  }

  /**
   * Try to match a key sequence
   */
  private trySequence(
    key: string,
    modifiers: ModifierState,
    event: globalThis.KeyboardEvent
  ): boolean {
    // Skip if any modifiers are pressed (sequences are modifier-free)
    if (modifiers.ctrl || modifiers.alt || modifiers.meta) {
      this.clearSequence();
      return false;
    }

    const buffer = this.state.sequenceBuffer;
    const now = Date.now();

    // Check if sequence timed out
    if (buffer.keys.length > 0 && now - buffer.timestamp > SEQUENCE_TIMEOUT) {
      this.clearSequence();
    }

    // Add key to buffer
    const newKeys = [...buffer.keys, key];
    const sequenceStr = newKeys.join('');

    // Look for matching sequence
    for (const [, definitions] of this.hotkeys) {
      for (const def of definitions) {
        if (!def.combo.sequence) continue;
        if (!this.isModeAllowed(def)) continue;

        const targetSequence = def.combo.sequence.join('');

        if (targetSequence === sequenceStr) {
          // Complete match!
          event.preventDefault();
          event.stopPropagation();
          this.clearSequence();
          this.emit({ type: 'sequence_completed', sequence: newKeys });
          this.emit({
            type: 'hotkey_triggered',
            combo: def.combo,
            description: def.description,
          });
          def.action();
          return true;
        }

        if (targetSequence.startsWith(sequenceStr)) {
          // Partial match - continue building sequence
          this.state.sequenceBuffer = { keys: newKeys, timestamp: now };
          this.state.pendingSequence = sequenceStr;
          this.emit({ type: 'sequence_started', key: sequenceStr });

          // Set timeout to clear sequence
          if (this.sequenceTimeoutId) {
            window.clearTimeout(this.sequenceTimeoutId);
          }
          this.sequenceTimeoutId = window.setTimeout(() => {
            this.clearSequence();
            this.emit({ type: 'sequence_cancelled' });
          }, SEQUENCE_TIMEOUT);

          event.preventDefault();
          return true;
        }
      }
    }

    // No sequence match - clear buffer
    this.clearSequence();
    return false;
  }

  /**
   * Try to match a direct hotkey
   */
  private tryHotkey(
    key: string,
    modifiers: ModifierState,
    event: globalThis.KeyboardEvent
  ): boolean {
    // Build lookup key for non-sequence hotkeys
    const lookupKey = this.buildLookupKey(key, modifiers);
    const definitions = this.hotkeys.get(lookupKey);

    if (!definitions) return false;

    for (const def of definitions) {
      if (def.combo.sequence) continue; // Skip sequences
      if (!this.isModeAllowed(def)) continue;
      if (!modifiersMatch(modifiers, def.combo.modifiers)) continue;

      // Match found!
      event.preventDefault();
      event.stopPropagation();
      this.emit({
        type: 'hotkey_triggered',
        combo: def.combo,
        description: def.description,
      });
      def.action();
      return true;
    }

    return false;
  }

  /**
   * Check if this key could start a sequence
   */
  private startSequenceIfPossible(
    key: string,
    modifiers: ModifierState,
    event: globalThis.KeyboardEvent
  ): void {
    // Skip if any modifiers are pressed
    if (modifiers.ctrl || modifiers.alt || modifiers.meta) return;

    // Check if any sequence starts with this key
    for (const [, definitions] of this.hotkeys) {
      for (const def of definitions) {
        if (!def.combo.sequence) continue;
        if (!this.isModeAllowed(def)) continue;
        if (def.combo.sequence[0] === key) {
          // This key could start a sequence
          this.state.sequenceBuffer = { keys: [key], timestamp: Date.now() };
          this.state.pendingSequence = key;
          this.emit({ type: 'sequence_started', key });

          // Set timeout to clear sequence
          if (this.sequenceTimeoutId) {
            window.clearTimeout(this.sequenceTimeoutId);
          }
          this.sequenceTimeoutId = window.setTimeout(() => {
            this.clearSequence();
            this.emit({ type: 'sequence_cancelled' });
          }, SEQUENCE_TIMEOUT);

          event.preventDefault();
          return;
        }
      }
    }
  }

  /**
   * Clear the sequence buffer
   */
  private clearSequence(): void {
    this.state.sequenceBuffer = { keys: [], timestamp: 0 };
    this.state.pendingSequence = null;
    if (this.sequenceTimeoutId) {
      window.clearTimeout(this.sequenceTimeoutId);
      this.sequenceTimeoutId = null;
    }
  }

  /**
   * Check if a hotkey is allowed in current mode
   */
  private isModeAllowed(def: HotkeyDefinition): boolean {
    if (!def.modes || def.modes.length === 0) return true;
    return def.modes.includes(this.state.mode);
  }

  /**
   * Build a lookup key for a combo
   */
  private buildLookupKey(key: string, modifiers: ModifierState): string {
    const parts: string[] = [];
    if (modifiers.meta) parts.push('meta');
    if (modifiers.ctrl) parts.push('ctrl');
    if (modifiers.alt) parts.push('alt');
    if (modifiers.shift) parts.push('shift');
    parts.push(key.toLowerCase());
    return parts.join('+');
  }

  /**
   * Get the lookup key for a hotkey definition
   */
  private getHotkeyKey(combo: KeyCombo): string {
    if (combo.sequence) {
      return `seq:${combo.sequence.join('')}`;
    }
    const parts: string[] = [];
    if (combo.modifiers?.meta) parts.push('meta');
    if (combo.modifiers?.ctrl) parts.push('ctrl');
    if (combo.modifiers?.alt) parts.push('alt');
    if (combo.modifiers?.shift) parts.push('shift');
    parts.push(combo.key.toLowerCase());
    return parts.join('+');
  }

  /**
   * Emit an event to all listeners
   */
  private emit(event: KeyboardEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('Keyboard event listener error:', error);
      }
    }
  }
}

/**
 * Singleton instance
 */
let instance: KeyboardManager | null = null;

/**
 * Get the keyboard manager singleton
 */
export function getKeyboardManager(): KeyboardManager {
  if (!instance) {
    instance = new KeyboardManager();
    instance.init();
  }
  return instance;
}

/**
 * Reset keyboard manager (for testing)
 */
export function resetKeyboardManager(): void {
  if (instance) {
    instance.destroy();
    instance = null;
  }
}

export default KeyboardManager;
