import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { DEFAULT_THEME } from '../theme/themes';
import { CanvasSequenceGridRenderer } from './CanvasSequenceGridRenderer';

type Calls = {
  drawImage: number;
  fillRect: number;
  fillText: number;
};

function createMock2dContext(canvas: unknown) {
  const calls: Calls = { drawImage: 0, fillRect: 0, fillText: 0 };
  const gradient = { addColorStop: () => {} };

  const target: any = {
    canvas,
    __calls: calls,
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textBaseline: '',
    textAlign: '',
    lineWidth: 1,
    globalAlpha: 1,
    imageSmoothingEnabled: true,
    setTransform: () => {},
    resetTransform: () => {},
    scale: () => {},
    translate: () => {},
    rotate: () => {},
    save: () => {},
    restore: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    rect: () => {},
    arc: () => {},
    clip: () => {},
    stroke: () => {},
    fill: () => {},
    clearRect: () => {},
    drawImage: () => {
      calls.drawImage += 1;
    },
    fillRect: () => {
      calls.fillRect += 1;
    },
    fillText: () => {
      calls.fillText += 1;
    },
    measureText: (text: string) => ({ width: text.length * 8 }),
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    createPattern: () => ({}),
    setLineDash: () => {},
    getImageData: (_x: number, _y: number, w: number, h: number) => ({
      data: new Uint8ClampedArray(Math.max(0, w * h * 4)),
      width: w,
      height: h,
    }),
    putImageData: () => {},
  };

  return new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop in obj) return Reflect.get(obj, prop, receiver);
      // Default to a no-op function for unimplemented canvas APIs.
      return () => {};
    },
    set(obj, prop, value) {
      (obj as any)[prop] = value;
      return true;
    },
  });
}

describe('CanvasSequenceGridRenderer', () => {
  const contexts = new WeakMap<object, any>();
  let originalOffscreenCanvas: unknown;
  let originalRaf: typeof globalThis.requestAnimationFrame | undefined;
  let originalCancelRaf: typeof globalThis.cancelAnimationFrame | undefined;

  beforeEach(() => {
    originalOffscreenCanvas = (globalThis as any).OffscreenCanvas;

    if (typeof (globalThis as any).OffscreenCanvas !== 'function') {
      (globalThis as any).OffscreenCanvas = class OffscreenCanvas {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }
        getContext(type: string) {
          if (type !== '2d') return null;
          const existing = contexts.get(this);
          if (existing) return existing;
          const ctx = createMock2dContext(this);
          contexts.set(this, ctx);
          return ctx;
        }
      };
    }

    originalRaf = globalThis.requestAnimationFrame;
    originalCancelRaf = globalThis.cancelAnimationFrame;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 0) as any;
    (globalThis as any).cancelAnimationFrame = (handle: any) => clearTimeout(handle);
  });

  afterEach(() => {
    (globalThis as any).OffscreenCanvas = originalOffscreenCanvas;
    if (originalRaf) {
      globalThis.requestAnimationFrame = originalRaf;
    } else {
      // @ts-expect-error - allow deleting polyfill
      delete globalThis.requestAnimationFrame;
    }
    if (originalCancelRaf) {
      globalThis.cancelAnimationFrame = originalCancelRaf;
    } else {
      // @ts-expect-error - allow deleting polyfill
      delete globalThis.cancelAnimationFrame;
    }
  });

  it('renders a frame without throwing (smoke)', async () => {
    const OffscreenCanvasCtor = (globalThis as any).OffscreenCanvas as new (w: number, h: number) => any;
    const canvas = new OffscreenCanvasCtor(480, 240);
    const renderer = new CanvasSequenceGridRenderer({
      canvas,
      theme: DEFAULT_THEME,
      viewportWidth: 480,
      viewportHeight: 240,
      devicePixelRatio: 1,
      reducedMotion: true,
    });

    renderer.setSequence('ACGTACGTACGTACGTACGTACGT', 'dna', 0, null);

    // Flush RAF-driven render.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ctx = contexts.get(canvas as object);
    expect(ctx).toBeTruthy();

    const calls = (ctx as any).__calls as Calls | undefined;
    expect(calls).toBeTruthy();
    expect((calls!.drawImage + calls!.fillRect + calls!.fillText) > 0).toBe(true);

    renderer.dispose();
  });

  it('fills the canvas with the theme background on resize even while paused', () => {
    const OffscreenCanvasCtor = (globalThis as any).OffscreenCanvas as new (w: number, h: number) => any;
    const canvas = new OffscreenCanvasCtor(480, 240);
    const renderer = new CanvasSequenceGridRenderer({
      canvas,
      theme: DEFAULT_THEME,
      viewportWidth: 480,
      viewportHeight: 240,
      devicePixelRatio: 1,
      reducedMotion: true,
    });

    const ctx = contexts.get(canvas as object);
    const calls = (ctx as any).__calls as Calls;
    const fillsBefore = calls.fillRect;

    renderer.pause();
    renderer.resize(320, 160);

    // Resize must paint immediately. Waiting for rAF would flash black on iOS URL-bar resizes.
    expect(calls.fillRect).toBeGreaterThan(fillsBefore);

    renderer.dispose();
  });

  it('redraws after resume from pause', async () => {
    const OffscreenCanvasCtor = (globalThis as any).OffscreenCanvas as new (w: number, h: number) => any;
    const canvas = new OffscreenCanvasCtor(480, 240);
    const renderer = new CanvasSequenceGridRenderer({
      canvas,
      theme: DEFAULT_THEME,
      viewportWidth: 480,
      viewportHeight: 240,
      devicePixelRatio: 1,
      reducedMotion: true,
    });
    renderer.setSequence('ACGTACGTACGTACGTACGTACGT', 'dna', 0, null);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const ctx = contexts.get(canvas as object);
    const calls = (ctx as any).__calls as Calls;
    const drawsBefore = calls.drawImage + calls.fillRect + calls.fillText;

    renderer.pause();
    expect(renderer.isPaused()).toBe(true);
    renderer.resume();
    expect(renderer.isPaused()).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls.drawImage + calls.fillRect + calls.fillText).toBeGreaterThan(drawsBefore);

    renderer.dispose();
  });
});
