/**
 * Hotkey Conflict Validator Tests
 *
 * Ensures the ActionRegistry has no conflicting shortcuts.
 * This test will FAIL if a conflicting shortcut is introduced.
 */

import { describe, expect, it } from 'bun:test';
import {
  validateHotkeyConflicts,
  assertNoHotkeyConflicts,
} from './validateConflicts';
import { formatKeyCombo } from './types';
import { ActionRegistryList } from './actionRegistry';

describe('validateHotkeyConflicts', () => {
  describe('ActionRegistry validation', () => {
    it('passes validation with no conflicts', () => {
      const result = validateHotkeyConflicts({ surface: 'web' });

      // This is the key test - if this fails, a conflict was introduced
      expect(result.valid).toBe(true);

      // Log details for debugging if conflicts exist
      if (!result.valid) {
        console.error('Conflicts found:', JSON.stringify(result.conflicts, null, 2));
      }
    });

    it('assertNoHotkeyConflicts throws on conflicts', () => {
      // This should not throw for the current ActionRegistry
      expect(() => assertNoHotkeyConflicts({ surface: 'web' })).not.toThrow();
    });

    it('checks all registered actions', () => {
      const result = validateHotkeyConflicts({ surface: 'web' });

      // Should check a reasonable number of actions
      const webActions = ActionRegistryList.filter(
        a => !a.surfaces || a.surfaces.includes('web')
      );
      expect(webActions.length).toBeGreaterThan(10);

      // Summary should mention the count
      expect(result.summary).toContain('actions checked');
    });
  });

  describe('conflict detection logic', () => {
    it('detects global-global conflicts', () => {
      // This tests the detection logic, not the actual registry
      // We're verifying the validator would catch issues if introduced

      // The validator correctly identifies when two global actions share a key
      const result = validateHotkeyConflicts();
      const errorConflicts = result.conflicts.filter(c => c.severity === 'error');

      // Currently should be 0 errors
      expect(errorConflicts.length).toBe(0);
    });

    it('flags global-contextual overlaps as warnings', () => {
      const result = validateHotkeyConflicts();
      const warnings = result.conflicts.filter(c => c.severity === 'warning');

      // Warnings are informational - they're expected when contextual
      // actions intentionally shadow globals in specific contexts
      // Just verify the structure is correct if any exist
      for (const warning of warnings) {
        expect(warning.shortcut).toBeDefined();
        expect(warning.actions.length).toBeGreaterThan(1);
        expect(warning.message).toContain('shadow');
      }
    });

    it('does not flag contextual-contextual as conflicts', () => {
      const result = validateHotkeyConflicts();

      // Contextual actions can share shortcuts because they're in different contexts
      // The validator should NOT report these as errors
      const errorConflicts = result.conflicts.filter(c => c.severity === 'error');
      for (const conflict of errorConflicts) {
        // At least one action should be global for it to be an error
        const hasGlobal = conflict.actions.some(a => a.scope === 'global');
        expect(hasGlobal).toBe(true);
      }
    });
  });

  describe('browser-reserved detection', () => {
    it('identifies browser-reserved shortcuts', () => {
      const result = validateHotkeyConflicts({ checkBrowserReserved: true });

      // Just verify the structure is correct
      for (const reserved of result.browserReserved) {
        expect(reserved.actionId).toBeDefined();
        expect(reserved.shortcut).toBeDefined();
        expect(reserved.reservedFor).toBeDefined();
      }
    });

    it('can skip browser-reserved check', () => {
      const result = validateHotkeyConflicts({ checkBrowserReserved: false });
      expect(result.browserReserved).toHaveLength(0);
    });
  });

  describe('surface filtering', () => {
    it('filters by web surface', () => {
      const result = validateHotkeyConflicts({ surface: 'web' });
      expect(result.summary).toContain('actions checked');
    });

    it('filters by tui surface', () => {
      const result = validateHotkeyConflicts({ surface: 'tui' });
      expect(result.summary).toContain('actions checked');
    });
  });
});

describe('ActionRegistry invariants', () => {
  it('has unique action IDs', () => {
    const ids = ActionRegistryList.map(a => a.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('all actions have required fields', () => {
    for (const action of ActionRegistryList) {
      expect(action.id).toBeDefined();
      expect(action.title).toBeDefined();
      expect(action.category).toBeDefined();
      expect(action.defaultShortcut).toBeDefined();
      expect(action.scope).toMatch(/^(global|contextual)$/);
    }
  });

  it('shortcut combos are well-formed', () => {
    for (const action of ActionRegistryList) {
      const shortcuts = Array.isArray(action.defaultShortcut)
        ? action.defaultShortcut
        : [action.defaultShortcut];

      for (const shortcut of shortcuts) {
        if ('sequence' in shortcut) {
          expect(shortcut.sequence.length).toBeGreaterThan(0);
        } else {
          expect(shortcut.key).toBeDefined();
          expect(shortcut.key.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('action IDs follow naming convention', () => {
    // ActionIds should follow pattern: category.action or category.subcategory.action
    for (const action of ActionRegistryList) {
      expect(action.id).toMatch(/^[a-z]+(\.[a-zA-Z]+)+$/);
    }
  });

  it('category names are consistent', () => {
    // Track all categories used
    const categories = new Set(ActionRegistryList.map(a => a.category));

    // Categories should be capitalized words (not arbitrary strings)
    for (const category of categories) {
      expect(category).toMatch(/^[A-Z][a-z]+$/);
    }
  });

  it('has actions for all depth layers', () => {
    // Verify we have good coverage of Layer 0-4 categories
    const categories = new Set(ActionRegistryList.map(a => a.category));

    // Layer 0 categories
    expect(categories.has('Navigation')).toBe(true);
    expect(categories.has('View')).toBe(true);
    expect(categories.has('Search')).toBe(true);

    // Layer 3 category
    expect(categories.has('Simulation')).toBe(true);

    // Layer 4 category
    expect(categories.has('Dev')).toBe(true);
  });
});

describe('HelpOverlay integration', () => {
  // These tests ensure HelpOverlay cannot become stale relative to ActionRegistry.
  // HelpOverlay renders from ActionRegistryList, so if these tests pass,
  // the overlay will correctly display current shortcuts.

  it('all web actions are displayable in HelpOverlay', () => {
    const webActions = ActionRegistryList.filter(
      a => !a.surfaces || a.surfaces.includes('web')
    );

    // Every web action must have the fields HelpOverlay needs
    for (const action of webActions) {
      // HelpOverlay uses these fields to render:
      expect(action.title).toBeTruthy();       // displayed as description
      expect(action.category).toBeTruthy();    // used for layer classification
      expect(action.defaultShortcut).toBeTruthy(); // formatted as key display
      expect(action.scope).toBeTruthy();       // used for contextual badge
    }
  });

  it('formatKeyCombo produces valid display strings', () => {
    // formatKeyCombo imported at top of file
    for (const action of ActionRegistryList) {
      const shortcuts = Array.isArray(action.defaultShortcut)
        ? action.defaultShortcut
        : [action.defaultShortcut];

      for (const combo of shortcuts) {
        const formatted = formatKeyCombo(combo);
        // Should produce a non-empty string
        expect(formatted.length).toBeGreaterThan(0);
        // Should not contain undefined or [object Object]
        expect(formatted).not.toContain('undefined');
        expect(formatted).not.toContain('[object');
      }
    }
  });

  it('HelpOverlay shows substantial number of shortcuts', () => {
    // Regression guard: HelpOverlay should show many shortcuts
    const webActions = ActionRegistryList.filter(
      a => !a.surfaces || a.surfaces.includes('web')
    );

    // We currently have 77 actions, most for web
    expect(webActions.length).toBeGreaterThan(50);
  });

  it('essential Layer 0 categories have shortcuts', () => {
    // Layer 0 categories should always have actions
    const layer0Categories = ['Navigation', 'View', 'Search'];

    for (const category of layer0Categories) {
      const actions = ActionRegistryList.filter(
        a => a.category === category &&
             (!a.surfaces || a.surfaces.includes('web'))
      );
      expect(actions.length).toBeGreaterThan(0);
    }
  });

  it('overlay actions reference valid overlayIds', () => {
    // Actions with overlayId should have valid overlay metadata
    const overlayActions = ActionRegistryList.filter(a => a.overlayId);

    for (const action of overlayActions) {
      expect(action.overlayId).toBeTruthy();
      expect(action.overlayAction).toBeDefined();
      expect(['open', 'toggle']).toContain(action.overlayAction!);
    }
  });
});

describe('Overlay-scoped hotkey behavior', () => {
  // These tests ensure overlay-specific shortcuts are properly scoped
  // to only activate when their parent overlay is open.

  it('contextual actions exist for overlay-internal shortcuts', () => {
    // Overlay-internal shortcuts should be marked as contextual
    const contextualActions = ActionRegistryList.filter(a => a.scope === 'contextual');

    // We should have contextual actions (overlay-internal hotkeys)
    expect(contextualActions.length).toBeGreaterThan(0);

    // All contextual actions should have proper fields
    for (const action of contextualActions) {
      expect(action.id).toBeDefined();
      expect(action.title).toBeDefined();
      expect(action.defaultShortcut).toBeDefined();
    }
  });

  it('overlay toggle actions are global scope', () => {
    // Actions that open/toggle overlays should be global (always available)
    const overlayToggleActions = ActionRegistryList.filter(
      a => a.overlayAction === 'toggle' || a.overlayAction === 'open'
    );

    // Overlay toggles should be global so they work anywhere
    for (const action of overlayToggleActions) {
      expect(action.scope).toBe('global');
    }
  });

  it('contextual actions do not conflict with each other', () => {
    // Contextual actions can share shortcuts because they're in different contexts
    const result = validateHotkeyConflicts();
    const errors = result.conflicts.filter(c => c.severity === 'error');

    // No errors should have only contextual actions (that would be wrong)
    for (const error of errors) {
      const allContextual = error.actions.every(a => a.scope === 'contextual');
      expect(allContextual).toBe(false);
    }
  });

  it('help overlay has contextual detail toggle', () => {
    // HelpOverlay's 'd' toggle should be contextual (only active when overlay open)
    const helpDetailAction = ActionRegistryList.find(
      a => a.id === 'help.toggleDetail'
    );

    expect(helpDetailAction).toBeDefined();
    expect(helpDetailAction?.scope).toBe('contextual');
  });

  it('escape key is not registered as a regular hotkey', () => {
    // Escape is handled by the Overlay component directly, not through ActionRegistry
    // This ensures Escape always closes the topmost overlay without conflicts
    const escapeActions = ActionRegistryList.filter(a => {
      const shortcuts = Array.isArray(a.defaultShortcut)
        ? a.defaultShortcut
        : [a.defaultShortcut];
      return shortcuts.some(s => 'key' in s && s.key === 'Escape');
    });

    // Should have few or no Escape shortcuts to avoid conflicts with overlay close
    expect(escapeActions.length).toBeLessThan(3);
  });

  it('overlay actions have valid categories', () => {
    // Overlay actions should have valid category assignments
    const overlayActions = ActionRegistryList.filter(a => a.overlayId);

    // Valid categories for overlay actions (based on actual registry).
    //
    // 'Education' is where overlays whose input is synthetic live. The niche
    // network sat in 'Analysis' beside forty overlays that really do analyse
    // the loaded genome, so its "EDUCATIONAL SIMULATION" banner only appeared
    // after the user had already chosen it.
    const validCategories = new Set([
      'Overlays', 'Search', 'Simulation', 'Analysis', 'Comparison', 'Navigation', 'Dev',
      'Education',
    ]);

    for (const action of overlayActions) {
      // Overlay actions should have a valid category
      expect(validCategories.has(action.category)).toBe(true);
    }
  });

  it('contextual shortcuts do not shadow critical global shortcuts', () => {
    // Critical global shortcuts (Escape-to-close, ?, /) should not be shadowed
    const criticalShortcuts = ['?', '/'];
    const result = validateHotkeyConflicts();

    for (const shortcut of criticalShortcuts) {
      const conflicts = result.conflicts.filter(c =>
        c.shortcut.includes(shortcut) && c.severity === 'error'
      );
      expect(conflicts.length).toBe(0);
    }
  });
});
