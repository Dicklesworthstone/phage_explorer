import { useCollaborationStore } from '../collaboration/CollaborationManager';

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
