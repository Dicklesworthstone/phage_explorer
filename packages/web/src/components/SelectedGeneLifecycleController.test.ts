import { describe, expect, it } from 'bun:test';
import { shouldClearSelectedGene } from './SelectedGeneLifecycleController';

describe('shouldClearSelectedGene', () => {
  it('clears only when one loaded phage is replaced by another', () => {
    expect(shouldClearSelectedGene(1, 2)).toBe(true);
    expect(shouldClearSelectedGene(2, 2)).toBe(false);
  });

  it('does not erase a deep-linked selection during initial loading', () => {
    expect(shouldClearSelectedGene(null, 2)).toBe(false);
    expect(shouldClearSelectedGene(null, null)).toBe(false);
  });

  it('waits through transient null state instead of guessing', () => {
    expect(shouldClearSelectedGene(2, null)).toBe(false);
  });
});
