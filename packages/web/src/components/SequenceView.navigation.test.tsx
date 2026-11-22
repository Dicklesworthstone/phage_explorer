import React, { act, createContext } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import createReconciler from 'react-reconciler';
import { ConcurrentRoot, DefaultEventPriority, NoEventPriority } from 'react-reconciler/constants';
import { usePhageStore } from '@phage-explorer/state';
import { computeSequenceDiff } from '@phage-explorer/comparison';
import { ComparisonDiffView } from './overlays/ComparisonOverlay';
import { SequenceView } from './SequenceView';
import { resetKeyboardManager } from '../keyboard/KeyboardManager';
import { useWebPreferences } from '../store/createWebStore';

type Props = Record<string, unknown>;
const noop = () => {};

/** Native host nodes retain actual React handlers and refs. The real sequence
 * renderer runs against a no-op 2D drawing surface; this is not browser/pixel QA.
 */
class HostNode extends EventTarget {
  children: HostNode[] = [];
  parent: HostNode | null = null;
  width = 640;
  height = 320;
  clientWidth = 640;
  clientHeight = 320;
  dataset: Record<string, unknown> = {};
  style = { setProperty: noop };
  classList = { add: noop, remove: noop };
  draws = 0;
  constructor(public type: string, public props: Props = {}, public text = '') { super(); }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 320, width: 640, height: 320 }; }
  getContext(type: string) {
    if (type !== '2d') return null;
    const values: Record<string, unknown> = { canvas: this, measureText: (text: string) => ({ width: text.length * 8 }),
      createLinearGradient: () => ({ addColorStop: noop }), createRadialGradient: () => ({ addColorStop: noop }),
      fillRect: () => { this.draws++; }, drawImage: () => { this.draws++; }, fillText: () => { this.draws++; } };
    return new Proxy(values, { get: (target, key) => Reflect.get(target, key) ?? noop });
  }
  append(child: HostNode) {
    if (child.parent) child.parent.children = child.parent.children.filter(node => node !== child);
    child.parent = this; this.children.push(child);
  }
  remove(child: HostNode) { this.children = this.children.filter(node => node !== child); child.parent = null; }
  insert(child: HostNode, before: HostNode) {
    this.append(child); this.children.pop(); this.children.splice(this.children.indexOf(before), 0, child);
  }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  all(): HostNode[] { return [this, ...this.children.flatMap(child => child.all())]; }
}

type HostConfig = createReconciler.HostConfig<string, Props, HostNode, HostNode, HostNode,
  never, never, never, never, HostNode, object, never, ReturnType<typeof setTimeout>, -1,
  null, null, null, never, never, never>;
let priority = NoEventPriority;
const context = {};
const hostConfig: HostConfig = {
  supportsMutation: true, supportsPersistence: false, supportsHydration: false,
  isPrimaryRenderer: true, rendererVersion: '1', rendererPackageName: 'phage-explorer-native-navigation-test',
  extraDevToolsConfig: null, bindToConsole: () => noop,
  createInstance: (type, props) => new HostNode(type, props), createTextInstance: text => new HostNode('#text', {}, text),
  appendInitialChild: (parent, child) => parent.append(child),
  appendChild: (parent, child) => parent.append(child), appendChildToContainer: (parent, child) => parent.append(child),
  insertBefore: (parent, child, before) => parent.insert(child, before),
  insertInContainerBefore: (parent, child, before) => parent.insert(child, before),
  removeChild: (parent, child) => parent.remove(child), removeChildFromContainer: (parent, child) => parent.remove(child),
  clearContainer: parent => { parent.children = []; }, resetTextContent: node => { node.text = ''; },
  commitTextUpdate: (node, _old, value) => { node.text = value; },
  commitUpdate: (node, _type, _old, props) => { node.props = props; },
  finalizeInitialChildren: () => false, shouldSetTextContent: () => false,
  getRootHostContext: () => context, getChildHostContext: () => context, getPublicInstance: node => node,
  prepareForCommit: () => null, resetAfterCommit: noop, preparePortalMount: noop,
  scheduleTimeout: setTimeout, cancelTimeout: clearTimeout, noTimeout: -1,
  supportsMicrotasks: true, scheduleMicrotask: queueMicrotask,
  getInstanceFromNode: () => null, beforeActiveInstanceBlur: noop, afterActiveInstanceBlur: noop,
  prepareScopeUpdate: noop, getInstanceFromScope: () => null, detachDeletedInstance: noop,
  NotPendingTransition: null, HostTransitionContext: createContext(null), resetFormInstance: noop,
  setCurrentUpdatePriority: value => { priority = value; }, getCurrentUpdatePriority: () => priority,
  resolveUpdatePriority: () => priority === NoEventPriority ? DefaultEventPriority : priority,
  requestPostPaintCallback: noop, shouldAttemptEagerTransition: () => false, trackSchedulerEvent: noop,
  resolveEventType: () => null, resolveEventTimeStamp: () => performance.now(),
  maySuspendCommit: () => false, maySuspendCommitOnUpdate: () => false, maySuspendCommitInSyncRender: () => false,
  preloadInstance: () => true, startSuspendingCommit: () => null, suspendInstance: noop,
  suspendOnActiveViewTransition: noop, waitForCommitToBeReady: () => null, getSuspendedCommitReason: () => null,
};
const renderer = createReconciler(hostConfig);

const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const frames = new Map<number, ReturnType<typeof setTimeout>>();
let frameId = 0;
let container: HostNode;
let root: ReturnType<typeof renderer.createContainer> | undefined;
let errors: unknown[];
let originalPreferences: Pick<ReturnType<typeof useWebPreferences.getState>, 'scanlines' | 'glow'>;

function replaceGlobal(key: string, value: unknown) {
  originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

async function settle(action: () => void = noop) {
  await act(async () => {
    renderer.flushSyncFromReconciler(action);
    // The production hook coalesces actual renderer callbacks at 50 ms.
    await new Promise(resolve => setTimeout(resolve, 80));
  });
  if (errors.length) throw errors[0];
}
async function mount(element: React.ReactNode) {
  const fail = (error: unknown) => errors.push(error);
  root = renderer.createContainer(container, ConcurrentRoot, null, false, null, '', fail, fail, fail, noop, null);
  await settle(() => { renderer.updateContainerSync(element, root!, null); renderer.flushSyncWork(); });
}
function find(predicate: (node: HostNode) => boolean): HostNode {
  const node = container.all().find(predicate);
  if (!node) throw new Error('Expected native host control is absent.');
  return node;
}
function labelled(label: string): HostNode { return find(node => node.props['aria-label'] === label); }
function invoke(node: HostNode, name: string, event: unknown = {}) {
  const handler = node.props[name];
  if (typeof handler !== 'function') throw new Error(`Missing actual component handler: ${name}`);
  handler(event);
}
function position(): string { return find(node => node.props.className === 'sequence-view__jump-status').textContent; }
function navigation() {
  const { scrollPosition, zoomScale, viewMode, readingFrame } = usePhageStore.getState();
  return { scrollPosition, zoomScale, viewMode, readingFrame };
}
async function jump(value: string) {
  await settle(() => invoke(find(node => node.props.className === 'sequence-view__jump-input'), 'onChange', { target: { value } }));
  await settle(() => invoke(find(node => node.props.className === 'sequence-view__jump-form'), 'onSubmit', { preventDefault: noop }));
}

beforeEach(() => {
  errors = []; container = new HostNode('root');
  originalPreferences = { scanlines: useWebPreferences.getState().scanlines, glow: useWebPreferences.getState().glow };
  const document = Object.assign(new EventTarget(), { documentElement: new HostNode('html'), hidden: false,
    activeElement: null, createElement: (type: string) => new HostNode(type) });
  const window = Object.assign(new EventTarget(), { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    setTimeout, clearTimeout, matchMedia: (query: string) => Object.assign(new EventTarget(), {
      matches: query.includes('reduced-motion') || query.includes('prefers-color-scheme: dark'),
    }) });
  replaceGlobal('window', window); replaceGlobal('document', document);
  replaceGlobal('navigator', { maxTouchPoints: 0, userAgent: 'phage-explorer-native-test' });
  replaceGlobal('getComputedStyle', () => ({ paddingLeft: '6' }));
  replaceGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  replaceGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = ++frameId;
    frames.set(id, setTimeout(() => { frames.delete(id); callback(performance.now()); }, 16));
    return id;
  });
  replaceGlobal('cancelAnimationFrame', (id: number) => { clearTimeout(frames.get(id)); frames.delete(id); });
  replaceGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  usePhageStore.getState().reset();
  useWebPreferences.setState({ scanlines: false, glow: false });
});

afterEach(async () => {
  if (root) await act(() => { renderer.updateContainerSync(null, root!, null); renderer.flushSyncWork(); });
  root = undefined;
  resetKeyboardManager();
  for (const timer of frames.values()) clearTimeout(timer);
  frames.clear();
  usePhageStore.getState().reset();
  useWebPreferences.setState(originalPreferences);
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  originalGlobals.clear();
});

describe('mounted comparison viewport ownership (native host, real 2D renderer)', () => {
  it('isolates initial state, actual jumps/clicks/wheel/diff navigation, zoom and view controls in both directions', async () => {
    usePhageStore.setState({ scrollPosition: 1234, zoomScale: 2, viewMode: 'aa', readingFrame: -2 });
    const before = navigation();
    const sequenceA = 'G'.repeat(10000), sequenceB = 'G'.repeat(9999) + 'C';
    await mount(<ComparisonDiffView diff={computeSequenceDiff(sequenceA, sequenceB)} sequenceA={sequenceA} sequenceB={sequenceB} />);
    expect(labelled('DNA view').props['aria-checked']).toBe(true);
    expect(position()).toContain('Pos: 0/10,000');
    expect(navigation()).toEqual(before);

    await settle(() => invoke(labelled('Next diff'), 'onClick'));
    expect(position()).not.toContain('Pos: 0/');
    await jump('4000');
    expect(position()).not.toContain('Pos: 0/');
    const bar = find(node => node.props.title === 'Tap or click to jump');
    await settle(() => invoke(bar, 'onClick', { currentTarget: bar, clientX: 300 }));
    const canvas = labelled('Genome sequence canvas');
    await settle(() => invoke(canvas, 'onClick', { clientX: 100, clientY: 40 }));
    const beforeWheel = position();
    await settle(() => canvas.parent!.dispatchEvent(Object.assign(new Event('wheel', { cancelable: true }), {
      deltaX: 0, deltaY: 400, deltaMode: 0, ctrlKey: false,
    })));
    expect(position()).not.toBe(beforeWheel);
    await settle(() => invoke(labelled('Zoom in'), 'onClick'));
    await settle(() => invoke(labelled('Dual view'), 'onClick'));
    await settle(() => invoke(find(node => String(node.props['aria-label']).startsWith('Cycle reading frame, currently')), 'onClick'));
    await settle(() => invoke(labelled('DNA view'), 'onClick'));
    expect(navigation()).toEqual(before);
    expect(canvas.draws).toBeGreaterThan(0);

    await jump('6000');
    const localPosition = position(), localZoom = find(node => node.props.className === 'sequence-view__zoom-label').textContent;
    await settle(() => usePhageStore.setState({ scrollPosition: 20, zoomScale: 0.5, viewMode: 'dual', readingFrame: 1 }));
    expect(position()).toBe(localPosition);
    expect(find(node => node.props.className === 'sequence-view__zoom-label').textContent).toBe(localZoom);
    expect(labelled('DNA view').props['aria-checked']).toBe(true);
    expect(navigation()).toEqual({ scrollPosition: 20, zoomScale: 0.5, viewMode: 'dual', readingFrame: 1 });
  });

  it('preserves the ordinary explorer control path and incoming store navigation', async () => {
    usePhageStore.setState({ viewMode: 'dna', scrollPosition: 0, readingFrame: 0, zoomScale: 1 });
    await mount(<SequenceView sequence={'ACGT'.repeat(2500)} height={320} />);
    await jump('4000');
    expect(usePhageStore.getState().scrollPosition).toBeGreaterThan(3000);
    expect(position()).toContain(usePhageStore.getState().scrollPosition.toLocaleString());
    await settle(() => invoke(labelled('Zoom in'), 'onClick'));
    expect(usePhageStore.getState().zoomScale).toBeGreaterThan(1);
    await settle(() => invoke(labelled('Amino Acids view'), 'onClick'));
    expect(usePhageStore.getState().viewMode).toBe('aa');
    await settle(() => invoke(find(node => String(node.props['aria-label']).startsWith('Cycle reading frame, currently')), 'onClick'));
    expect(usePhageStore.getState().readingFrame).toBe(1);
    await settle(() => invoke(labelled('DNA view'), 'onClick'));
    await settle(() => usePhageStore.getState().setScrollPosition(8000));
    expect(position()).toContain(usePhageStore.getState().scrollPosition.toLocaleString());
    expect(usePhageStore.getState().scrollPosition).toBeGreaterThan(7500);
  });
});
