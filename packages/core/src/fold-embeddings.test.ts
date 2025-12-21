import { describe, it, expect } from 'bun:test';
import { encodeFloat32VectorLE, decodeFloat32VectorLE } from './fold-embeddings';

describe('fold-embeddings float32 codec', () => {
  it('round-trips a small vector', () => {
    const input = [0.1, -0.2, 3.5, Math.PI];
    const bytes = encodeFloat32VectorLE(input);
    const output = decodeFloat32VectorLE(bytes, input.length);

    expect(output).toHaveLength(input.length);
    for (let i = 0; i < input.length; i++) {
      expect(output[i]).toBeCloseTo(input[i], 6);
    }
  });
});

