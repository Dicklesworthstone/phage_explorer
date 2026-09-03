import { describe, expect, it } from 'bun:test';
import { ActionIds, ActionRegistry, ActionRegistryList } from '../keyboard/actionRegistry';
import { useCollaborationStore } from './CollaborationManager';

describe('Multi-Tab Sync & Collaboration Action (phage_explorer-9vk4.2)', () => {
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
