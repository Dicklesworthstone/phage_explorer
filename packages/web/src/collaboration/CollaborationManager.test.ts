import { describe, expect, it } from 'bun:test';
import { ActionIds, ActionRegistry, ActionRegistryList } from '../keyboard/actionRegistry';
import { createCollaborationStore, useCollaborationStore } from './CollaborationManager';
import type { SavedView } from '../../../core/src/saved-views';
import type { ShareableOverlayId } from '../utils/share-state';

function endpoint(key: string) {
  const store = createCollaborationStore(), listeners = new Set<() => void>();
  const fingerprint = key.repeat(64);
  let view: SavedView | null = {
    source: { kind: 'catalog', name: key, accession: key, slug: key, bases: 100, sequenceSha256: fingerprint,
      contentId: fingerprint, fingerprint },
    view: { contentId: fingerprint, viewMode: 'dna', readingFrame: 0, scrollPosition: 0, geneId: null },
  };
  let tool: ShareableOverlayId | null = null;
  const notify = () => listeners.forEach(listener => listener());
  store.getState().attachExplorer({
    navigation: {
      currentCatalogView: () => structuredClone(view),
      followCatalogView: async shared => { view = structuredClone(shared); notify(); return true; },
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    },
    currentTool: () => tool,
    showTool: next => { tool = next; store.getState().explorerChanged(); },
  });
  return { store, view: () => view, tool: () => tool, private: () => { view = null; notify(); },
    scroll: (position: number) => { view!.view.scrollPosition = position; notify(); },
    open: (next: ShareableOverlayId) => { tool = next; store.getState().explorerChanged(); } };
}

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}

describe('Multi-Tab Sync & Collaboration Action (phage_explorer-9vk4.2)', () => {
  it('initializes a named-group joiner and synchronizes changes over actual BroadcastChannels without echoing or sharing private views', async () => {
    const a = endpoint('a'), b = endpoint('b'), other = endpoint('c');
    const id = crypto.randomUUID(), observer = new BroadcastChannel('phage_explorer_collab');
    const received: Array<{ sender: string; state: { navigation?: SavedView } }> = [];
    observer.onmessage = event => {
      const msg = event.data;
      if (msg.type === 'state' && msg.payload.sessionId === id) received.push({ sender: msg.sender, state: msg.payload.state });
    };
    try {
      a.scroll(21);
      await a.store.getState().joinSession(id, 'first');
      await Bun.sleep(2);
      await other.store.getState().joinSession(id + '-other', 'other group');
      await b.store.getState().joinSession(id, 'second');
      await until(() => b.view()?.view.scrollPosition === 21);
      expect(b.view()?.source.accession).toBe('a');
      expect(b.store.getState().hostId).toBe(a.store.getState().currentUser.id);
      b.scroll(33);
      await until(() => a.view()?.view.scrollPosition === 33);
      await Bun.sleep(120);
      expect(received.filter(msg => msg.state.navigation?.view.scrollPosition === 33)).toHaveLength(1);
      expect(other.view()?.view.scrollPosition).toBe(0);
      a.store.getState().setSyncOverlays(true); b.store.getState().setSyncOverlays(true);
      await Bun.sleep(120);
      a.open('complexity'); await until(() => b.tool() === 'complexity');
      a.scroll(50); a.private(); await Bun.sleep(120);
      expect(received.some(msg => msg.state.navigation?.view.scrollPosition === 50)).toBe(false);
      b.scroll(71); await Bun.sleep(120);
      expect(a.view()).toBeNull();
      a.store.getState().leaveSession();
      await until(() => b.store.getState().hostId === b.store.getState().currentUser.id);
    } finally {
      a.store.getState().dispose(); b.store.getState().dispose(); other.store.getState().dispose(); observer.close();
    }
  });
  it('registers Multi-Tab Sync in ActionRegistry with overlayId collaboration', () => {
    const action = ActionRegistry[ActionIds.OverlayCollaboration];
    expect(action).toBeDefined();
    expect(action.overlayId).toBe('collaboration');
    expect(action.title).toBe('Multi-Tab Sync');
    expect(action.category).toBe('Overlays');
  });

  it('is reachable in ActionRegistryList for Command Palette search', () => {
    const found = ActionRegistryList.find((a) => a.overlayId === 'collaboration');
    expect(found).toBeDefined();
    expect(found?.id).toBe(ActionIds.OverlayCollaboration);
    expect(found?.title).toBe('Multi-Tab Sync');
  });

  it('connects to local session and updates peer state', async () => {
    const store = useCollaborationStore.getState();
    expect(store.connected).toBe(false);

    await store.joinSession('test-room', 'TestTab');

    const connectedState = useCollaborationStore.getState();
    expect(connectedState.connected).toBe(true);
    expect(connectedState.id).toBe('test-room');
    expect(connectedState.currentUser.name).toBe('TestTab');
    expect(Object.keys(connectedState.peers).length).toBeGreaterThanOrEqual(1);

    // Send chat note
    connectedState.sendMessage('Hello other tab');
    expect(useCollaborationStore.getState().chatMessages.length).toBe(1);
    expect(useCollaborationStore.getState().chatMessages[0].text).toBe('Hello other tab');

    // Leave session
    useCollaborationStore.getState().leaveSession();
    expect(useCollaborationStore.getState().connected).toBe(false);
    expect(useCollaborationStore.getState().id).toBe('');
  });

  it('discrimination check: does not claim remote WebRTC signaling', () => {
    const action = ActionRegistry[ActionIds.OverlayCollaboration];
    expect(action.description).not.toContain('WebRTC');
    expect(action.description).not.toContain('remote peer');
    expect(action.description).toContain('browser tabs');
  });
});
