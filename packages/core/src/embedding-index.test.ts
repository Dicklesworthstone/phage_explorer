import { describe, it, expect } from 'bun:test';
import { EmbeddingIndex } from './embedding-index';

describe('EmbeddingIndex', () => {
  it('adds and retrieves size correctly', () => {
    const index = new EmbeddingIndex();
    expect(index.size()).toBe(0);

    index.add('a', [1, 0, 0]);
    index.add('b', [0, 1, 0]);
    expect(index.size()).toBe(2);
    expect(index.has('a')).toBe(true);
    expect(index.has('c')).toBe(false);

    index.clear();
    expect(index.size()).toBe(0);
    expect(index.has('a')).toBe(false);
  });

  it('updates existing item if added with same id', () => {
    const index = new EmbeddingIndex();
    index.add('a', [1, 0, 0], { label: 'first' });
    expect(index.size()).toBe(1);

    index.add('a', [0, 1, 0], { label: 'second' });
    expect(index.size()).toBe(1);

    const hits = index.search([0, 1, 0], 1);
    expect(hits[0].id).toBe('a');
    expect(hits[0].distance).toBeCloseTo(0, 5);
    expect(hits[0].metadata?.label).toBe('second');
  });

  it('planted case: retrieves itself first with distance 0, then its true homologue', () => {
    const index = new EmbeddingIndex<{ name: string }>();

    // Target protein vector
    const target = [0.5, 0.5, 0.5, 0.5];
    // Homologue: small perturbation
    const homologue = [0.52, 0.48, 0.51, 0.49];
    // Unrelated protein: orthogonal direction
    const unrelated = [0.5, -0.5, 0.5, -0.5];

    index.add('target', target, { name: 'AcrIIA4' });
    index.add('homologue', homologue, { name: 'AcrIIA4-variant' });
    index.add('unrelated', unrelated, { name: 'Capsid' });

    const results = index.search(target, 3);
    expect(results.length).toBe(3);

    // 1st hit is self: distance 0.0
    expect(results[0].id).toBe('target');
    expect(results[0].distance).toBeCloseTo(0.0, 5);
    expect(results[0].similarity).toBeCloseTo(1.0, 5);

    // 2nd hit is true homologue: small distance
    expect(results[1].id).toBe('homologue');
    expect(results[1].distance).toBeLessThan(0.01);
    expect(results[1].distance).toBeGreaterThan(0.0);

    // 3rd hit is unrelated: larger distance
    expect(results[2].id).toBe('unrelated');
    expect(results[2].distance).toBeGreaterThan(results[1].distance);
  });

  it('respects maxDistance threshold and k limit', () => {
    const index = new EmbeddingIndex();
    index.add('v1', [1, 0, 0]);
    index.add('v2', [0.9, 0.1, 0]);
    index.add('v3', [0, 1, 0]);

    // maxDistance filter
    const closeHits = index.search([1, 0, 0], 10, 0.05);
    expect(closeHits.length).toBe(2);
    expect(closeHits.map((h) => h.id)).toEqual(['v1', 'v2']);

    // k limit
    const top1 = index.search([1, 0, 0], 1);
    expect(top1.length).toBe(1);
    expect(top1[0].id).toBe('v1');
  });

  it('computes static cosineDistance correctly', () => {
    const distIdentical = EmbeddingIndex.cosineDistance([1, 2, 3], [1, 2, 3]);
    expect(distIdentical).toBeCloseTo(0, 5);

    const distOrthogonal = EmbeddingIndex.cosineDistance([1, 0], [0, 1]);
    expect(distOrthogonal).toBeCloseTo(1, 5);

    const distOpposite = EmbeddingIndex.cosineDistance([1, 0], [-1, 0]);
    expect(distOpposite).toBeCloseTo(2, 5);
  });
});
