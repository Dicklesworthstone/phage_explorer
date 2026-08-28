import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Theme } from '@phage-explorer/core';
import { DEFAULT_THEME } from '../../theme/themes';
import { WebGLSequenceRenderer } from './WebGLSequenceRenderer';

type GLStats = {
  clearColor: number[][];
  clear: number;
  viewport: number;
};

function createFakeGL(stats: GLStats): WebGL2RenderingContext {
  const attribs: Record<string, number> = {
    a_position: 0,
    a_texCoord: 1,
    a_instanceIndex: 2,
  };
  let next = 1;
  const alloc = () => ({ id: next++ });

  const gl: Record<string | number, unknown> = {
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713,
    LINK_STATUS: 35714,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    DYNAMIC_DRAW: 35048,
    FLOAT: 5126,
    TEXTURE_2D: 3553,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    CLAMP_TO_EDGE: 33071,
    NEAREST: 9728,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240,
    COLOR_BUFFER_BIT: 16384,
    TEXTURE0: 33984,
    TEXTURE1: 33985,
    TRIANGLE_STRIP: 5,
    MAX_TEXTURE_SIZE: 3379,
    createShader: () => alloc(),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => alloc(),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: () => {},
    getAttribLocation: (_program: unknown, name: string) => attribs[name] ?? 0,
    getUniformLocation: (_program: unknown, name: string) => ({ name }),
    createBuffer: () => alloc(),
    bindBuffer: () => {},
    bufferData: () => {},
    deleteBuffer: () => {},
    createVertexArray: () => alloc(),
    bindVertexArray: () => {},
    deleteVertexArray: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribDivisor: () => {},
    createTexture: () => alloc(),
    bindTexture: () => {},
    texImage2D: () => {},
    texParameteri: () => {},
    deleteTexture: () => {},
    useProgram: () => {},
    uniform2f: () => {},
    uniform1f: () => {},
    uniform1i: () => {},
    activeTexture: () => {},
    drawArraysInstanced: () => {},
    getParameter: (pname: number) => (pname === 3379 ? 4096 : 0),
    getExtension: (name: string) => {
      if (name === 'ANGLE_instanced_arrays') {
        return {
          drawArraysInstancedANGLE: () => {},
          vertexAttribDivisorANGLE: () => {},
        };
      }
      if (name === 'WEBGL_lose_context') {
        return { loseContext: () => {}, restoreContext: () => {} };
      }
      return null;
    },
    viewport: () => {
      stats.viewport += 1;
    },
    clearColor: (r: number, g: number, b: number, a: number) => {
      stats.clearColor.push([r, g, b, a]);
    },
    clear: () => {
      stats.clear += 1;
    },
  };

  return gl as unknown as WebGL2RenderingContext;
}

class FakeCanvas {
  width = 1;
  height = 1;
  clientWidth = 320;
  clientHeight = 180;
  private listeners = new Map<string, Set<EventListener>>();
  constructor(private gl: WebGL2RenderingContext) {}

  addEventListener(type: string, listener: EventListener): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatchEvent(event: Event): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener.call(this, event);
    }
    return true;
  }

  getContext(type: string): WebGL2RenderingContext | null {
    if (type === 'webgl2' || type === 'webgl') return this.gl;
    return null;
  }
}

describe('WebGLSequenceRenderer', () => {
  let originalRaf: typeof globalThis.requestAnimationFrame | undefined;
  let originalCancelRaf: typeof globalThis.cancelAnimationFrame | undefined;
  let originalOffscreen: unknown;

  beforeEach(() => {
    if (typeof (globalThis as any).HTMLCanvasElement === 'undefined') {
      (globalThis as any).HTMLCanvasElement = class HTMLCanvasElement {};
    }
    originalOffscreen = (globalThis as any).OffscreenCanvas;
    if (typeof (globalThis as any).OffscreenCanvas !== 'function') {
      (globalThis as any).OffscreenCanvas = class OffscreenCanvas {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }
        getContext() {
          return {
            canvas: this,
            fillStyle: '',
            font: '',
            textBaseline: '',
            textAlign: '',
            imageSmoothingEnabled: true,
            setTransform: () => {},
            scale: () => {},
            clearRect: () => {},
            fillRect: () => {},
            fillText: () => {},
            measureText: (text: string) => ({
              width: text.length * 8,
              actualBoundingBoxAscent: 8,
              actualBoundingBoxDescent: 2,
            }),
          };
        }
      };
    }

    originalRaf = globalThis.requestAnimationFrame;
    originalCancelRaf = globalThis.cancelAnimationFrame;
    (globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) =>
      setTimeout(() => cb(performance.now()), 0) as unknown as number;
    (globalThis as any).cancelAnimationFrame = (handle: number) => clearTimeout(handle);
  });

  afterEach(() => {
    (globalThis as any).OffscreenCanvas = originalOffscreen;
    if (originalRaf) globalThis.requestAnimationFrame = originalRaf;
    if (originalCancelRaf) globalThis.cancelAnimationFrame = originalCancelRaf;
  });

  function makeRenderer() {
    const stats: GLStats = { clearColor: [], clear: 0, viewport: 0 };
    const gl = createFakeGL(stats);
    const canvas = new FakeCanvas(gl);
    const renderer = new WebGLSequenceRenderer({
      canvas: canvas as unknown as HTMLCanvasElement,
      theme: DEFAULT_THEME as unknown as Theme,
      viewportWidth: 320,
      viewportHeight: 180,
      devicePixelRatio: 1,
    });
    return { renderer, canvas, stats };
  }

  it('clears to the theme background immediately on resize, even while paused', () => {
    const { renderer, stats } = makeRenderer();
    const clearsAtConstruct = stats.clear;
    expect(clearsAtConstruct).toBeGreaterThan(0);

    renderer.pause();
    const clearsBefore = stats.clear;
    renderer.resize(640, 360);

    expect(stats.clear).toBeGreaterThan(clearsBefore);
    const last = stats.clearColor.at(-1);
    expect(last).toBeTruthy();
    // Holographic background #030014 must not fall back to opaque black (0,0,0).
    expect(last![0]).toBeCloseTo(0x03 / 255, 5);
    expect(last![2]).toBeCloseTo(0x14 / 255, 5);

    renderer.dispose();
  });

  it('does not zero the drawing buffer on a 0-size resize', () => {
    const { renderer, canvas } = makeRenderer();
    canvas.width = 320;
    canvas.height = 180;
    renderer.resize(0, 0);
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(180);
    renderer.dispose();
  });

  it('prevents default on context lost so Safari can restore, then redraws on restore', async () => {
    const { renderer, canvas, stats } = makeRenderer();
    renderer.setState({
      sequence: 'ACGTACGTACGTACGT',
      aminoSequence: null,
      viewMode: 'dna',
      readingFrame: 0,
      diffSequence: null,
      diffEnabled: false,
      diffMask: null,
    });

    let prevented = false;
    const lost = new Event('webglcontextlost');
    lost.preventDefault = () => {
      prevented = true;
    };
    canvas.dispatchEvent(lost);
    expect(prevented).toBe(true);

    const clearsBeforeRestore = stats.clear;
    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(stats.clear).toBeGreaterThan(clearsBeforeRestore);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(renderer.isPaused()).toBe(false);

    renderer.dispose();
  });

  it('forces a redraw on resume after pause', async () => {
    const { renderer, stats } = makeRenderer();
    renderer.setState({
      sequence: 'ACGTACGTACGTACGT',
      aminoSequence: null,
      viewMode: 'dna',
      readingFrame: 0,
      diffSequence: null,
      diffEnabled: false,
      diffMask: null,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    renderer.pause();
    const clearsBefore = stats.clear;
    renderer.resume();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stats.clear).toBeGreaterThan(clearsBefore);
    renderer.dispose();
  });
});
