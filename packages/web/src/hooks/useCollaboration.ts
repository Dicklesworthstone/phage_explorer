import { useCollaborationStore } from '../collaboration/CollaborationManager';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useOverlay } from '../components/overlays/OverlayProvider';
import { getShareableTool } from '../utils/share-state';
import type { BrowserNavigationSession } from './BrowserNavigationSession';

export function useCollaborationExplorer(navigation: BrowserNavigationSession): void {
  const { stack, followSharedTool } = useOverlay();
  const tool = getShareableTool(stack);
  const latest = useRef(tool);
  useLayoutEffect(() => {
    latest.current = tool;
    useCollaborationStore.getState().explorerChanged();
  }, [tool]);
  useEffect(() => useCollaborationStore.getState().attachExplorer({
    navigation, currentTool: () => latest.current, showTool: followSharedTool,
  }), [navigation, followSharedTool]);
}

export function useCollaboration() {
  const store = useCollaborationStore();
  
  // Expose simplified interface
  return {
    isConnected: store.connected,
    sessionId: store.id,
    peers: Object.values(store.peers),
    currentUser: store.currentUser,
    hostId: store.hostId,
    chatMessages: store.chatMessages,
    syncNavigation: store.syncNavigation,
    syncOverlays: store.syncOverlays,
    
    createSession: store.createSession,
    joinSession: store.joinSession,
    leaveSession: store.leaveSession,
    updatePresence: store.updatePresence,
    sendMessage: store.sendMessage,
    setSyncNavigation: store.setSyncNavigation,
    setSyncOverlays: store.setSyncOverlays,
  };
}
