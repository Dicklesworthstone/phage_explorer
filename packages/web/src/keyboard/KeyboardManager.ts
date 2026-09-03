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
  KeyboardState,
  KeyboardEvent,
  KeyboardEventListener,
  ExperienceLevel,
} from './types';
import { meetsExperienceLevel, isSequenceCombo } from './types';

const SEQUENCE_TIMEOUT = 1000; // 1 second to complete a sequence
const ALL_MODES: KeyboardMode[] = ['NORMAL', 'SEARCH', 'COMMAND', 'VISUAL', 'INSERT'];

/**
 * Check if an element is editable (user typing context).
 */
function isEditableElement(element: Element | null): boolean {
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
 * Detect if the user is typing in an input/textarea/select/contenteditable element.
 * Uses composedPath when available to support shadow DOM.
 */
export function isUserTyping(event: globalThis.KeyboardEvent): boolean {
  if (typeof document === 'undefined') return false;

  const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
  for (const entry of path) {
    if (entry instanceof Element && isEditableElement(entry)) return true;
  }

  const target = event.target instanceof Element ? event.target : null;
  if (isEditableElement(target)) return true;

  const active = document.activeElement;
  if (isEditableElement(active)) return true;

  const shadowActive = (active && 'shadowRoot' in active) ? active.shadowRoot?.activeElement ?? null : null;
  if (isEditableElement(shadowActive)) return true;

  return false;
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

function shouldIncludeShiftInKey(key: string): boolean {
  // Shift is meaningful for single-letter hotkeys because we lowercase keys
  // for case-insensitive matching and need shift to distinguish e.g. Alt+P vs Alt+Shift+P.
  // For punctuation/symbol keys, the shifted character is already represented by `event.key`
  // (e.g. '?' vs '/', '+' vs '=') so including shift would double-count it.
  return key.length === 1 && /[a-z]/i.test(key);
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
  private experienceLevel: ExperienceLevel = 'novice';

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
   * Get current experience level
   */
  getExperienceLevel(): ExperienceLevel {
    return this.experienceLevel;
  }

  /**
   * Set experience level for hotkey filtering
   */
  setExperienceLevel(level: ExperienceLevel): void {
    this.experienceLevel = level;
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

    if (import.meta.env.DEV) {
      this.warnIfHotkeyConflicts(definition, existing);
    }

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
   * Subscribe to keyboard events. Returns an unsubscribe function.
   */
  subscribe(listener: KeyboardEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Add event listener (alias for subscribe)
   */
  addEventListener(listener: KeyboardEventListener): () => void {
    return this.subscribe(listener);
  }

  /**
   * Remove event listener
   */
  removeEventListener(listener: KeyboardEventListener): void {
    this.listeners.delete(listener);
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

    const typing = isUserTyping(event);
    const typingBlocks = typing;
    const modifiers = getModifiers(event);
    const key = event.key;

    // Check for sequence match first
    if (this.trySequence(key, modifiers, event, typingBlocks)) {
      return;
    }

    // Check for direct hotkey match
    if (this.tryHotkey(key, modifiers, event, typingBlocks)) {
      return;
    }

    // Start a new sequence if this key could be the start of one
    this.startSequenceIfPossible(key, modifiers, event, typingBlocks);
  }

  /**
   * Try to match a key sequence
   */
  private trySequence(
    key: string,
    modifiers: ModifierState,
    event: globalThis.KeyboardEvent,
    typingBlocks: boolean
  ): boolean {
    // Skip if any modifiers are pressed (sequences are modifier-free)
    if (modifiers.ctrl || modifiers.alt || modifiers.meta) {
      this.clearSequence();
      return false;
    }

    const buffer = this.state.sequenceBuffer;
    const now = Date.now();

    // Check if sequence timed out
    const isTimeout = now - buffer.timestamp > SEQUENCE_TIMEOUT;
    const currentKeys = isTimeout ? [] : buffer.keys;
    if (currentKeys.length === 0) {
      return false;
    }

    const newKeys = [...currentKeys, key];
    const sequenceStr = newKeys.join('');

    // Look for matching sequence
    for (const [, definitions] of this.hotkeys) {
      for (const def of definitions) {
        if (!isSequenceCombo(def.combo)) continue;
        if (!this.isModeAllowed(def)) continue;
        if (typingBlocks && !def.allowInInput) continue;

        const targetSequence = def.combo.sequence.join('');

        if (targetSequence === sequenceStr) {
          // Complete match! Check experience level
          if (!meetsExperienceLevel(this.experienceLevel, def.minLevel)) {
            event.preventDefault();
            event.stopPropagation();
            this.clearSequence();
            this.emit({
              type: 'hotkey_blocked',
              combo: def.combo,
              description: def.description,
              requiredLevel: def.minLevel!,
              currentLevel: this.experienceLevel,
            });
            return true;
          }
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
    event: globalThis.KeyboardEvent,
    typingBlocks: boolean
  ): boolean {
    // Build lookup key for non-sequence hotkeys
    const lookupKey = this.buildLookupKey(key, modifiers);
    const definitions = this.hotkeys.get(lookupKey);

    if (!definitions) return false;

    for (const def of definitions) {
      if (isSequenceCombo(def.combo)) continue; // Skip sequences
      if (!this.isModeAllowed(def)) continue;
      if (!modifiersMatch(modifiers, def.combo.modifiers)) continue;
      if (typingBlocks && !def.allowInInput) continue;

      // Match found! Check experience level
      if (!meetsExperienceLevel(this.experienceLevel, def.minLevel)) {
        event.preventDefault();
        event.stopPropagation();
        this.emit({
          type: 'hotkey_blocked',
          combo: def.combo,
          description: def.description,
          requiredLevel: def.minLevel!,
          currentLevel: this.experienceLevel,
        });
        return true;
      }

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
    event: globalThis.KeyboardEvent,
    typingBlocks: boolean
  ): void {
    // Skip if any modifiers are pressed
    if (modifiers.ctrl || modifiers.alt || modifiers.meta) return;

    // Check if any sequence starts with this key
    for (const [, definitions] of this.hotkeys) {
      for (const def of definitions) {
        if (!isSequenceCombo(def.combo)) continue;
        if (!this.isModeAllowed(def)) continue;
        if (typingBlocks && !def.allowInInput) continue;
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

  private getAllowedModesForDefinition(def: HotkeyDefinition): ReadonlyArray<KeyboardMode> {
    if (!def.modes || def.modes.length === 0) return ALL_MODES;
    return def.modes;
  }

  private getModeOverlap(a: HotkeyDefinition, b: HotkeyDefinition): KeyboardMode[] {
    const aModes = this.getAllowedModesForDefinition(a);
    const bModes = this.getAllowedModesForDefinition(b);
    return aModes.filter((mode) => bModes.includes(mode));
  }

  private comboRequiresCtrlAltMeta(combo: KeyCombo): boolean {
    if ('sequence' in combo) return false;
    const modifiers = combo.modifiers;
    return Boolean(modifiers?.ctrl || modifiers?.alt || modifiers?.meta);
  }

  private getLikelyEventKeyForSingleKeyCombo(combo: KeyCombo): string | null {
    if ('sequence' in combo) return null;
    const shift = combo.modifiers?.shift ?? false;
    const key = combo.key;

    if (key.length === 1 && /[a-z]/i.test(key)) {
      return shift ? key.toUpperCase() : key.toLowerCase();
    }

    return key;
  }

  private warnIfHotkeyConflicts(incoming: HotkeyDefinition, existing: HotkeyDefinition[]): void {
    const incomingPriority = incoming.priority ?? 0;

    for (const prev of existing) {
      const overlap = this.getModeOverlap(incoming, prev);
      if (overlap.length === 0) continue;

      const prevPriority = prev.priority ?? 0;
      if (prevPriority !== incomingPriority) continue;

      console.warn(
        `[keyboard] Hotkey conflict for "${incoming.description}" (priority=${incomingPriority}) vs "${prev.description}" in modes [${overlap.join(
          ', '
        )}]. Consider adjusting priorities or modes.`
      );
    }

    if ('sequence' in incoming.combo) {
      const incomingSequence = incoming.combo.sequence.join('');

      const firstKey = incoming.combo.sequence[0];
      if (!firstKey) return;
      const possibleShadowed = this.findSingleKeyHotkeysForEventKey(firstKey);
      for (const prev of possibleShadowed) {
        const overlap = this.getModeOverlap(incoming, prev);
        if (overlap.length === 0) continue;
        console.warn(
          `[keyboard] Hotkey "${prev.description}" may never trigger in modes [${overlap.join(
            ', '
          )}] because a sequence starting with "${firstKey}" is registered ("${incoming.description}").`
        );
      }

      const prefixConflicts = this.findSequencePrefixConflicts(incoming);
      for (const prev of prefixConflicts) {
        const overlap = this.getModeOverlap(incoming, prev);
        if (overlap.length === 0) continue;
        if (!('sequence' in prev.combo)) continue;

        const prevSequence = prev.combo.sequence.join('');
        if (incomingSequence.startsWith(prevSequence)) {
          console.warn(
            `[keyboard] Sequence "${incoming.description}" ("${incomingSequence}") may never trigger in modes [${overlap.join(
              ', '
            )}] because "${prev.description}" ("${prevSequence}") is a prefix and will fire earlier.`
          );
        } else if (prevSequence.startsWith(incomingSequence)) {
          console.warn(
            `[keyboard] Sequence "${prev.description}" ("${prevSequence}") may never trigger in modes [${overlap.join(
              ', '
            )}] because "${incoming.description}" ("${incomingSequence}") is a prefix and will fire earlier.`
          );
        }
      }

      return;
    }

    if (this.comboRequiresCtrlAltMeta(incoming.combo)) {
      return;
    }

    const eventKey = this.getLikelyEventKeyForSingleKeyCombo(incoming.combo);
    if (!eventKey) return;

    const starterSequences = this.findSequenceHotkeysStartingWithKey(eventKey);
    for (const prev of starterSequences) {
      const overlap = this.getModeOverlap(incoming, prev);
      if (overlap.length === 0) continue;
      console.warn(
        `[keyboard] Hotkey "${incoming.description}" may never trigger in modes [${overlap.join(
          ', '
        )}] because a sequence starting with "${eventKey}" is registered ("${prev.description}").`
      );
    }
  }

  private findSequenceHotkeysStartingWithKey(key: string): HotkeyDefinition[] {
    const matches: HotkeyDefinition[] = [];
    for (const definitions of this.hotkeys.values()) {
      for (const def of definitions) {
        if (!('sequence' in def.combo)) continue;
        if (def.combo.sequence[0] === key) matches.push(def);
      }
    }
    return matches;
  }

  private findSequencePrefixConflicts(incoming: HotkeyDefinition): HotkeyDefinition[] {
    if (!('sequence' in incoming.combo)) return [];
    const incomingSequence = incoming.combo.sequence.join('');

    const matches: HotkeyDefinition[] = [];
    for (const definitions of this.hotkeys.values()) {
      for (const def of definitions) {
        if (!('sequence' in def.combo)) continue;
        const otherSequence = def.combo.sequence.join('');
        if (otherSequence === incomingSequence) continue;
        if (otherSequence.startsWith(incomingSequence) || incomingSequence.startsWith(otherSequence)) {
          matches.push(def);
        }
      }
    }

    return matches;
  }

  private findSingleKeyHotkeysForEventKey(key: string): HotkeyDefinition[] {
    const matches: HotkeyDefinition[] = [];
    for (const definitions of this.hotkeys.values()) {
      for (const def of definitions) {
        if ('sequence' in def.combo) continue;
        if (this.comboRequiresCtrlAltMeta(def.combo)) continue;
        const eventKey = this.getLikelyEventKeyForSingleKeyCombo(def.combo);
        if (!eventKey) continue;
        if (eventKey !== key) continue;
        matches.push(def);
      }
    }
    return matches;
  }

  /**
   * Build a lookup key for a combo
   */
  private buildLookupKey(key: string, modifiers: ModifierState): string {
    const parts: string[] = [];
    if (modifiers.meta) parts.push('meta');
    if (modifiers.ctrl) parts.push('ctrl');
    if (modifiers.alt) parts.push('alt');
    if (modifiers.shift && shouldIncludeShiftInKey(key)) parts.push('shift');
    parts.push(key.toLowerCase());
    return parts.join('+');
  }

  /**
   * Get the lookup key for a hotkey definition
   */
  private getHotkeyKey(combo: KeyCombo): string {
    if (isSequenceCombo(combo)) {
      return `seq:${combo.sequence.join('')}`;
    }
    const parts: string[] = [];
    if (combo.modifiers?.meta) parts.push('meta');
    if (combo.modifiers?.ctrl) parts.push('ctrl');
    if (combo.modifiers?.alt) parts.push('alt');
    if (combo.modifiers?.shift && shouldIncludeShiftInKey(combo.key)) parts.push('shift');
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
let validationRan = false;

/**
 * Get the keyboard manager singleton
 */
export function getKeyboardManager(): KeyboardManager {
  if (!instance) {
    instance = new KeyboardManager();
    instance.init();

    // Run static ActionRegistry validation in dev mode (once)
    if (import.meta.env.DEV && !validationRan) {
      validationRan = true;
      // Lazy import to avoid circular dependencies and keep bundle lean in prod
      import('./validateConflicts').then(({ validateHotkeyConflicts, logValidationResults }) => {
        const result = validateHotkeyConflicts({ surface: 'web' });
        logValidationResults(result);
      }).catch(() => {
        // Validation module not available - skip silently
      });
    }
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
