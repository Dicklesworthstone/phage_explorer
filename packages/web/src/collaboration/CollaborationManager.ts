/**
 * Collaboration Manager
 *
 * Manages WebRTC peer connections and state synchronization.
 * Uses a mesh topology for simplicity (suitable for small groups < 5).
 */

import { create } from 'zustand';
import type { PeerId, SessionId, UserPresence, SyncMessage, SignalingMessage, SessionState } from './types';

// Generate a random ID
const generateId = () => Math.random().toString(36).substr(2, 9);

// Generate a random color
const generateColor = () => '#' + Math.floor(Math.random()*16777215).toString(16);

interface CollaborationStore extends SessionState {
  currentUser: UserPresence;
  messages: SyncMessage[];
  
  // Actions
  createSession: (name: string) => Promise<SessionId>;
  joinSession: (sessionId: SessionId, name: string) => Promise<void>;
  leaveSession: () => void;
  updatePresence: (presence: Partial<UserPresence>) => void;
  sendMessage: (text: string) => void;
  broadcastState: (state: any) => void;
}

// Broadcast channel for multi-tab coordination
const channel = new BroadcastChannel('phage_explorer_collab');

export const useCollaborationStore = create<CollaborationStore>((set, get) => {
  // Listen for messages from other tabs
  channel.onmessage = (event) => {
    const msg = event.data as SyncMessage;
    const state = get();
    
    if (msg.type === 'presence' && state.connected && state.id === msg.payload.sessionId) {
      const peer = msg.payload.user as UserPresence;
      if (peer.id !== state.currentUser.id) {
        set(s => ({
          peers: { ...s.peers, [peer.id]: peer }
        }));
      }
    } else if (msg.type === 'chat' && state.connected && state.id === msg.payload.sessionId) {
      set(s => ({
        messages: [...s.messages, msg]
      }));
    } else if (msg.type === 'join' && state.id === msg.payload.sessionId) {
        // Respond with my presence
        channel.postMessage({
            type: 'presence',
            sender: state.currentUser.id,
            timestamp: Date.now(),
            payload: { sessionId: state.id, user: state.currentUser }
        });
    }
  };

  return {
    id: '',
    hostId: '',
    peers: {},
    connected: false,
    currentUser: {
      id: generateId(),
      name: 'Anonymous',
      color: generateColor(),
      lastActive: Date.now(),
    },
    messages: [],

    createSession: async (name: string) => {
      const sessionId = generateId();
      const userId = get().currentUser.id;
      const user = { ...get().currentUser, name };
      
      set({
        id: sessionId,
        hostId: userId,
        connected: true,
        currentUser: user,
        peers: { [userId]: user }
      });
      
      console.log(`[Collaboration] Session created: ${sessionId}`);
      return sessionId;
    },

    joinSession: async (sessionId: SessionId, name: string) => {
      const userId = get().currentUser.id;
      const user = { ...get().currentUser, name };

      set({
        id: sessionId,
        hostId: 'host-placeholder', 
        connected: true,
        currentUser: user,
        peers: { [userId]: user }
      });
      
      // Announce join
      channel.postMessage({
        type: 'join',
        sender: userId,
        timestamp: Date.now(),
        payload: { sessionId, user }
      });
      
      // Broadcast presence
      channel.postMessage({
        type: 'presence',
        sender: userId,
        timestamp: Date.now(),
        payload: { sessionId, user }
      });
      
      console.log(`[Collaboration] Joined session: ${sessionId}`);
    },

    leaveSession: () => {
      set({
        id: '',
        hostId: '',
        connected: false,
        peers: {},
        messages: []
      });
    },

    updatePresence: (presence) => {
      const { currentUser, connected, id } = get();
      if (!connected) return;

      const updatedUser = { ...currentUser, ...presence, lastActive: Date.now() };
      set({ currentUser: updatedUser });
      
      set(state => ({
        peers: {
          ...state.peers,
          [currentUser.id]: updatedUser
        }
      }));

      channel.postMessage({
        type: 'presence',
        sender: currentUser.id,
        timestamp: Date.now(),
        payload: { sessionId: id, user: updatedUser }
      });
    },

    sendMessage: (text) => {
      const { currentUser, id } = get();
      const msg: SyncMessage = {
        type: 'chat',
        sender: currentUser.id,
        timestamp: Date.now(),
        payload: { text, sessionId: id }
      };
      
      set(state => ({
        messages: [...state.messages, msg]
      }));

      channel.postMessage(msg);
    },

    broadcastState: (payload) => {
      // Placeholder for state sync
    }
  };
});

// Hook for BroadcastChannel (multi-tab collaboration simulation)
export function useLocalSignaling() {
  // Logic moved inside store creator for simplicity
}
