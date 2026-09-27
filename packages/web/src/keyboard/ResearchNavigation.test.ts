import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { interruptsResearchNavigation, type ResearchNavigationState, type ResearchNavigationTarget } from './ResearchNavigation';

function fixture() {
  const controller = new AbortController();
  const state: ResearchNavigationState = { currentPhageIndex: 1, currentPhage: { localGenome: { contentId: 'alpha' } },
    selectedGeneId: 1, viewMode: 'dual', readingFrame: -2, scrollPosition: 0 };
  const owner: ResearchNavigationTarget = { index: 1, signal: controller.signal,
    view: { contentId: 'beta', geneId: 2, viewMode: 'dual', readingFrame: -2, scrollPosition: 20 } };
  return { controller, state, owner };
}
describe('asynchronous research navigation ownership', () => {
  it('keeps ownership when a new genome arrives and its old gene selection resets asynchronously', async () => {
    const { state, owner } = fixture();
    await Promise.resolve();
    const loaded = { ...state, currentPhage: { localGenome: { contentId: 'beta' } } };
    assert.equal(interruptsResearchNavigation(loaded, state, owner), false);
    await Promise.resolve();
    const cleared = { ...loaded, selectedGeneId: null };
    assert.equal(interruptsResearchNavigation(cleared, loaded, owner), false);
    const applied = { ...cleared, selectedGeneId: 2, scrollPosition: 20 };
    assert.equal(interruptsResearchNavigation(applied, cleared, owner), false);
    // The old predicate treated the automatic gene reset as an interruption.
    assert.notEqual(cleared.selectedGeneId, loaded.selectedGeneId);
  });
  it('allows the loader to reset an obsolete scroll position without cancelling itself', () => {
    const { state, owner } = fixture();
    assert.equal(interruptsResearchNavigation(state, { ...state, scrollPosition: 80 }, owner), false);
  });
  it('interrupts a different genome selection even while the owned loader is pending', () => {
    const { state, owner } = fixture();
    assert.equal(interruptsResearchNavigation({ ...state, currentPhageIndex: 2 }, state, owner), true);
    assert.equal(interruptsResearchNavigation({ ...state, currentPhage: { localGenome: { contentId: 'gamma' } } }, state, owner), true);
    assert.equal(interruptsResearchNavigation({ ...state, currentPhage: null }, state, owner), true);
  });
  it('does not hide user frame, mode, gene or position changes behind an async navigation guard', () => {
    const { state, owner } = fixture();
    for (const change of [{ readingFrame: 1 }, { viewMode: 'aa' }, { selectedGeneId: 3 }, { scrollPosition: 35 }]) {
      assert.equal(interruptsResearchNavigation({ ...state, ...change }, state, owner), true);
    }
  });
  it('accepts intended frame and mode changes, but only for the owned destination', () => {
    const { state, owner } = fixture();
    owner.view.readingFrame = 1; owner.view.viewMode = 'aa';
    assert.equal(interruptsResearchNavigation({ ...state, readingFrame: 1, viewMode: 'aa' }, state, owner), false);
    assert.equal(interruptsResearchNavigation({ ...state, currentPhageIndex: 4, readingFrame: 1 }, state, owner), true);
  });
  it('an aborted owner cannot exempt late changes from cancellation', () => {
    const { state, owner, controller } = fixture(); controller.abort();
    assert.equal(interruptsResearchNavigation({ ...state, selectedGeneId: null }, state, owner), true);
  });
  it('unowned analyses and replays remain interruptible by every selection/view change', () => {
    const { state } = fixture();
    for (const change of [{ currentPhageIndex: 2 }, { selectedGeneId: null }, { readingFrame: 0 }, { viewMode: 'dna' }, { scrollPosition: 10 }]) {
      assert.equal(interruptsResearchNavigation({ ...state, ...change }, state, null), true);
    }
  });
  it('ignores unchanged navigation snapshots and unrelated loading metadata', () => {
    const { state, owner } = fixture();
    assert.equal(interruptsResearchNavigation({ ...state }, state, owner), false);
    assert.equal(interruptsResearchNavigation({ ...state }, state, null), false);
  });
});
