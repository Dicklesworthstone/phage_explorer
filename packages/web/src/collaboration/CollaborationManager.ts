/**
 * Collaboration Manager
 *
 * Manages local peer state synchronization via BroadcastChannel.
 * Simulates a collaborative session across tabs.
 */

import { create } from 'zustand';
import type { PeerId, SessionId, UserPresence, SyncMessage, SessionState } from './types';

// Generate a random ID
const generateId = () => Math.random().toString(36).substr(2, 9);

// Generate a random color
const generateColor = () => '#' + Math.floor(Math.random()*16777215).toString(16);

interface CollaborationStore extends SessionState {
  currentUser: UserPresence;

  // Actions
  createSession: (name: string) => Promise<SessionId>;
  joinSession: (sessionId: SessionId, name: string) => Promise<void>;
  leaveSession: () => void;
  updatePresence: (presence: Partial<UserPresence>) => void;
  broadcastState: (state: any) => void;
  dispose: () => void;
}

// Broadcast channel for multi-tab coordination - lazily initialized
let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel {
  if (!channel) {
    channel = new BroadcastChannel('phage_explorer_collab');
  }
  return channel;
}

function closeChannel(): void {
  if (channel) {
    channel.close();
    channel = null;
  }
}

export const useCollaborationStore = create<CollaborationStore>((set, get) => {
  // Setup message listener when store initializes
  const setupChannelListener = () => {
    const ch = getChannel();
    ch.onmessage = (event) => {
      const msg = event.data as SyncMessage;
      const state = get();

      if (msg.type === 'presence' && state.connected && state.id === msg.payload.sessionId) {
        const peer = msg.payload.user as UserPresence;
        if (peer.id !== state.currentUser.id) {
          set(s => ({
            peers: { ...s.peers, [peer.id]: peer }
          }));
        }
      } else if (msg.type === 'join' && state.id === msg.payload.sessionId) {
        // Respond with my presence
        ch.postMessage({
          type: 'presence',
          sender: state.currentUser.id,
          timestamp: Date.now(),
          payload: { sessionId: state.id, user: state.currentUser }
        });
      }
    };
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

    createSession: async (name: string) => {
      setupChannelListener();
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
      setupChannelListener();
      const ch = getChannel();
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
      ch.postMessage({
        type: 'join',
        sender: userId,
        timestamp: Date.now(),
        payload: { sessionId, user }
      });

      // Broadcast presence
      ch.postMessage({
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
      });
      // Close channel when leaving to avoid leaks
      closeChannel();
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

      const ch = getChannel();
      ch.postMessage({
        type: 'presence',
        sender: currentUser.id,
        timestamp: Date.now(),
        payload: { sessionId: id, user: updatedUser }
      });
    },

    broadcastState: (_payload) => {
      // Placeholder for state sync
    },

    dispose: () => {
      set({
        id: '',
        hostId: '',
        connected: false,
        peers: {},
      });
      closeChannel();
    }
  };
});
