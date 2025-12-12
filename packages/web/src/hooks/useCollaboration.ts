import { useCollaborationStore } from '../collaboration/CollaborationManager';

export function useCollaboration() {
  const store = useCollaborationStore();
  
  // Expose simplified interface
  return {
    isConnected: store.connected,
    sessionId: store.id,
    peers: Object.values(store.peers),
    currentUser: store.currentUser,
    
    createSession: store.createSession,
    joinSession: store.joinSession,
    leaveSession: store.leaveSession,
    updatePresence: store.updatePresence,
    sendMessage: store.sendMessage,
  };
}
