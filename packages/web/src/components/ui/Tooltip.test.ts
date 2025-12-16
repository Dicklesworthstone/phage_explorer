/**
 * Tests for Tooltip experience-level gating
 *
 * Verifies that hints are shown/hidden based on user experience level.
 */

import { describe, expect, it } from 'bun:test';
import { shouldShowHint, type HintType } from './Tooltip';

describe('shouldShowHint', () => {
  describe('definition hints', () => {
    it('shows for novice users', () => {
      expect(shouldShowHint('novice', 'definition')).toBe(true);
    });

    it('shows for intermediate users', () => {
      expect(shouldShowHint('intermediate', 'definition')).toBe(true);
    });

    it('shows for power users', () => {
      expect(shouldShowHint('power', 'definition')).toBe(true);
    });
  });

  describe('shortcut hints', () => {
    it('shows for novice users', () => {
      expect(shouldShowHint('novice', 'shortcut')).toBe(true);
    });

    it('shows for intermediate users', () => {
      expect(shouldShowHint('intermediate', 'shortcut')).toBe(true);
    });

    it('hides for power users who already know shortcuts', () => {
      expect(shouldShowHint('power', 'shortcut')).toBe(false);
    });
  });

  describe('feature discovery hints', () => {
    it('shows for novice users discovering features', () => {
      expect(shouldShowHint('novice', 'feature')).toBe(true);
    });

    it('hides for intermediate users', () => {
      expect(shouldShowHint('intermediate', 'feature')).toBe(false);
    });

    it('hides for power users', () => {
      expect(shouldShowHint('power', 'feature')).toBe(false);
    });
  });

  describe('advanced hints', () => {
    it('never auto-shows for novice users', () => {
      expect(shouldShowHint('novice', 'advanced')).toBe(false);
    });

    it('never auto-shows for intermediate users', () => {
      expect(shouldShowHint('intermediate', 'advanced')).toBe(false);
    });

    it('never auto-shows for power users', () => {
      expect(shouldShowHint('power', 'advanced')).toBe(false);
    });
  });

  describe('always hints', () => {
    it('shows for novice users', () => {
      expect(shouldShowHint('novice', 'always')).toBe(true);
    });

    it('shows for intermediate users', () => {
      expect(shouldShowHint('intermediate', 'always')).toBe(true);
    });

    it('shows for power users', () => {
      expect(shouldShowHint('power', 'always')).toBe(true);
    });
  });

  describe('hint type coverage', () => {
    const hintTypes: HintType[] = ['definition', 'shortcut', 'feature', 'advanced', 'always'];
    const levels = ['novice', 'intermediate', 'power'] as const;

    it('handles all hint type combinations without throwing', () => {
      for (const hintType of hintTypes) {
        for (const level of levels) {
          expect(() => shouldShowHint(level, hintType)).not.toThrow();
        }
      }
    });
  });
});
