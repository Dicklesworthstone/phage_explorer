import { describe, expect, test } from 'bun:test';
import { drawingBufferSize, encodeSequenceToTexture } from './webgl-dotplot';

describe('drawingBufferSize', () => {
  test('returns null for zero CSS size instead of a 0×0 drawing buffer', () => {
    expect(drawingBufferSize(0, 480, 2)).toBeNull();
    expect(drawingBufferSize(640, 0, 2)).toBeNull();
    expect(drawingBufferSize(640, 480, 0)).toBeNull();
  });

  test('rounds CSS size by device pixel ratio', () => {
    expect(drawingBufferSize(320, 180, 2)).toEqual({ width: 640, height: 360 });
    expect(drawingBufferSize(100.4, 50.6, 1.5)).toEqual({ width: 151, height: 76 });
  });
});

describe('encodeSequenceToTexture', () => {
  test('encodes A/C/G/T/N into the expected texture values', () => {
    const { data, width, height } = encodeSequenceToTexture('ACGTN');
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
    expect(data[0]).toBe(0);
    expect(data[1]).toBe(0.25);
    expect(data[2]).toBe(0.5);
    expect(data[3]).toBe(0.75);
    expect(data[4]).toBe(1);
  });

  test('empty sequence yields a 1×1 N texture', () => {
    const encoded = encodeSequenceToTexture('');
    expect(encoded).toEqual({ data: new Float32Array([1]), width: 1, height: 1 });
  });
});
