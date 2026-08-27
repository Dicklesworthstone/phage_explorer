import { describe, expect, it } from 'bun:test';
import { classifyLifecycle } from './PhagePickerSheet';

describe('classifyLifecycle', () => {
  it('recognizes common lytic labels', () => {
    expect(classifyLifecycle('Lytic')).toBe('lytic');
    expect(classifyLifecycle('Virulent')).toBe('lytic');
    expect(classifyLifecycle('Obligately lytic')).toBe('lytic');
  });

  it('recognizes common temperate labels', () => {
    expect(classifyLifecycle('Temperate')).toBe('temperate');
    expect(classifyLifecycle('Lysogenic')).toBe('temperate');
    expect(classifyLifecycle('Prophage-forming')).toBe('temperate');
  });

  it('normalizes whitespace and casing', () => {
    expect(classifyLifecycle('  TEMPERATE  ')).toBe('temperate');
    expect(classifyLifecycle('  virulent phage ')).toBe('lytic');
  });

  it('keeps missing and unfamiliar labels in other', () => {
    expect(classifyLifecycle(null)).toBe('other');
    expect(classifyLifecycle(undefined)).toBe('other');
    expect(classifyLifecycle('Chronic')).toBe('other');
  });
});
