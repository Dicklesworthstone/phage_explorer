/**
 * Collaboration Manager
 *
 * Manages local peer state synchronization via BroadcastChannel.
 * Simulates a collaborative session across tabs.
 */

import { create } from 'zustand';
import type { SessionId, UserPresence, SyncMessage, SessionState } from './types';
import { usePhageStore, type OverlayId } from '@phage-explorer/state';
import type { ReadingFrame, ViewMode } from '@phage-explorer/core';

// Generate a random ID
const generateId = () => Math.random().toString(36).slice(2, 11);

// Generate a random color
const generateColor = () => `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;

type SharedAppState = {
  phageId?: number;
  scrollPosition?: number;
  viewMode?: ViewMode;
  readingFrame?: ReadingFrame;
  overlays?: OverlayId[];
};

export type ChatMessage = {
  id: string;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
};

const isViewMode = (value: unknown): value is ViewMode =>
  value === 'dna' || value === 'aa' || value === 'dual';

const isReadingFrame = (value: unknown): value is ReadingFrame =>
  value === 0 || value === 1 || value === 2 || value === -1 || value === -2 || value === -3;

interface CollaborationStore extends SessionState {
  currentUser: UserPresence;
  chatMessages: ChatMessage[];
  syncNavigation: boolean;
  syncOverlays: boolean;

  // Actions
  createSession: (name: string) => Promise<SessionId>;
  joinSession: (sessionId: SessionId, name: string) => Promise<void>;
  leaveSession: () => void;
  updatePresence: (presence: Partial<UserPresence>) => void;
  setSyncNavigation: (enabled: boolean) => void;
  setSyncOverlays: (enabled: boolean) => void;
  broadcastState: (state: SharedAppState) => void;
  sendMessage: (text: string) => void;
  dispose: () => void;
}

// Broadcast channel for multi-tab coordination - lazily initialized
let channel: BroadcastChannel | null = null;
let listenerSetup = false;
let appStoreUnsubscribe: (() => void) | null = null;
let suppressAppStoreBroadcast = false;
let pendingStateBroadcast: SharedAppState | null = null;
let pendingStateBroadcastTimer: ReturnType<typeof setTimeout> | null = null;

const STATE_BROADCAST_THROTTLE_MS = 50;
const CHAT_HISTORY_LIMIT = 200;

function getChannel(): BroadcastChannel {
  if (!channel) {
    channel = new BroadcastChannel('phage_explorer_collab');
    // Note: listenerSetup is reset in closeChannel(), not here
    // This ensures the flag reflects actual listener state
  }
  return channel;
}

function closeChannel(): void {
  if (channel) {
    channel.close();
    channel = null;
    listenerSetup = false;
  }
}

export const useCollaborationStore = create<CollaborationStore>((set, get) => {
  const stopAppStoreSync = () => {
    if (appStoreUnsubscribe) {
      appStoreUnsubscribe();
      appStoreUnsubscribe = null;
    }
    if (pendingStateBroadcastTimer) {
      clearTimeout(pendingStateBroadcastTimer);
      pendingStateBroadcastTimer = null;
    }
    pendingStateBroadcast = null;
  };

  const pickSharedAppState = (appState: ReturnType<typeof usePhageStore.getState>): SharedAppState => {
    const syncNavigation = get().syncNavigation;
    const syncOverlays = get().syncOverlays;

    const shared: SharedAppState = {};
    if (syncNavigation) {
      shared.phageId = appState.phages[appState.currentPhageIndex]?.id;
      shared.scrollPosition = appState.scrollPosition;
      shared.viewMode = appState.viewMode;
      shared.readingFrame = appState.readingFrame;
    }
    if (syncOverlays) {
      shared.overlays = appState.overlays;
    }
    return shared;
  };

  const applyRemoteAppState = (remote: SharedAppState) => {
    const collab = get();
    if (!collab.connected) return;

    const app = usePhageStore.getState();

    // Prevent echo loops: remote changes should not be re-broadcast.
    suppressAppStoreBroadcast = true;

    try {
      if (collab.syncNavigation) {
        if (typeof remote.phageId === 'number') {
          const idx = app.phages.findIndex((p) => p.id === remote.phageId);
          if (idx >= 0 && idx !== app.currentPhageIndex) {
            app.setCurrentPhageIndex(idx);
          }
        }

        if (isViewMode(remote.viewMode)) {
          app.setViewMode(remote.viewMode);
        }
        if (isReadingFrame(remote.readingFrame)) {
          app.setReadingFrame(remote.readingFrame);
        }
        if (typeof remote.scrollPosition === 'number') {
          app.setScrollPosition(Math.max(0, remote.scrollPosition));
        }
      }

      if (collab.syncOverlays && Array.isArray(remote.overlays)) {
        usePhageStore.setState({ overlays: remote.overlays });
      }
    } finally {
      // Let any synchronous subscribers run before re-enabling broadcasts.
      Promise.resolve().then(() => {
        suppressAppStoreBroadcast = false;
      });
    }
  };

  const queueStateBroadcast = (nextState: SharedAppState) => {
    pendingStateBroadcast = { ...(pendingStateBroadcast ?? {}), ...nextState };
    if (pendingStateBroadcastTimer) return;

    pendingStateBroadcastTimer = setTimeout(() => {
      pendingStateBroadcastTimer = null;
      const payload = pendingStateBroadcast;
      pendingStateBroadcast = null;
      if (!payload) return;
      get().broadcastState(payload);
    }, STATE_BROADCAST_THROTTLE_MS);
  };

  const startAppStoreSync = () => {
    if (appStoreUnsubscribe) return;

    let lastJson = JSON.stringify(pickSharedAppState(usePhageStore.getState()));
    appStoreUnsubscribe = usePhageStore.subscribe((state) => {
      const collab = get();
      if (!collab.connected || !collab.id) return;
      if (suppressAppStoreBroadcast) {
        lastJson = JSON.stringify(pickSharedAppState(state));
        return;
      }

      const next = pickSharedAppState(state);
      const nextJson = JSON.stringify(next);
      if (nextJson === lastJson) return;
      lastJson = nextJson;
      queueStateBroadcast(next);
    });
  };

  // Setup message listener when store initializes (idempotent)
  const setupChannelListener = () => {
    if (listenerSetup) return; // Prevent duplicate listener setup

    const ch = getChannel();
    ch.onmessage = (event) => {
      const msg = event.data as SyncMessage;
      const state = get();

      if (msg.type === 'presence' && state.connected && state.id === msg.payload.sessionId) {
        const peer = msg.payload.user as UserPresence;
        const remoteHostId = msg.payload.hostId as string | undefined;
        if (peer.id !== state.currentUser.id) {
          set(s => ({
            hostId: remoteHostId && s.hostId !== remoteHostId ? remoteHostId : s.hostId,
            peers: { ...s.peers, [peer.id]: peer }
          }));
        }
      } else if (msg.type === 'join' && state.id === msg.payload.sessionId) {
        const joinerId = msg.sender;
        // Respond with my presence
        ch.postMessage({
          type: 'presence',
          sender: state.currentUser.id,
          timestamp: Date.now(),
          payload: { sessionId: state.id, user: state.currentUser, hostId: state.hostId }
        });

        // Host sends an initial state snapshot directly to the joiner.
        if (state.hostId === state.currentUser.id) {
          ch.postMessage({
            type: 'state',
            sender: state.currentUser.id,
            timestamp: Date.now(),
            payload: {
              sessionId: state.id,
              target: joinerId,
              hostId: state.hostId,
              state: pickSharedAppState(usePhageStore.getState()),
            },
          });
        }
      } else if (msg.type === 'state' && state.connected && state.id === msg.payload.sessionId) {
        const target = msg.payload.target as string | undefined;
        if (target && target !== state.currentUser.id) return;

        const remoteHostId = msg.payload.hostId as string | undefined;
        if (remoteHostId && state.hostId !== remoteHostId) {
          set({ hostId: remoteHostId });
        }

        const remoteState = msg.payload.state as SharedAppState | undefined;
        if (remoteState && msg.sender !== state.currentUser.id) {
          applyRemoteAppState(remoteState);
        }
      } else if (msg.type === 'chat' && state.connected && state.id === msg.payload.sessionId) {
        const chat = msg.payload.message as ChatMessage | undefined;
        if (!chat) return;
        if (chat.senderId === state.currentUser.id) return;

        set((s) => {
          if (s.chatMessages.some((m) => m.id === chat.id)) return s;
          return { chatMessages: [...s.chatMessages, chat].slice(-CHAT_HISTORY_LIMIT) };
        });
      } else if (msg.type === 'leave' && state.connected && state.id === msg.payload.sessionId) {
        const peerId = msg.sender;
        if (!peerId || peerId === state.currentUser.id) return;
        set((s) => {
          if (!s.peers[peerId]) return s;
          const nextPeers = { ...s.peers };
          delete nextPeers[peerId];
          return { peers: nextPeers };
        });
      }
    };
    listenerSetup = true;
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
    chatMessages: [],
    syncNavigation: true,
    syncOverlays: false,

    createSession: async (name: string) => {
      setupChannelListener();
      stopAppStoreSync();
      const sessionId = generateId();
      const userId = get().currentUser.id;
      const user = { ...get().currentUser, name };

      set({
        id: sessionId,
        hostId: userId,
        connected: true,
        currentUser: user,
        peers: { [userId]: user },
        chatMessages: [],
      });

      startAppStoreSync();

      if (import.meta.env.DEV) {
        console.log(`[Collaboration] Session created: ${sessionId}`);
      }
      return sessionId;
    },

    joinSession: async (sessionId: SessionId, name: string) => {
      setupChannelListener();
      stopAppStoreSync();
      const ch = getChannel();
      const userId = get().currentUser.id;
      const user = { ...get().currentUser, name };

      set({
        id: sessionId,
        hostId: '',
        connected: true,
        currentUser: user,
        peers: { [userId]: user },
        chatMessages: [],
      });

      startAppStoreSync();

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

      if (import.meta.env.DEV) {
        console.log(`[Collaboration] Joined session: ${sessionId}`);
      }
    },

    leaveSession: () => {
      const { connected, id, currentUser } = get();
      if (connected && id) {
        try {
          getChannel().postMessage({
            type: 'leave',
            sender: currentUser.id,
            timestamp: Date.now(),
            payload: { sessionId: id },
          });
        } catch {
          // Best effort
        }
      }

      set({
        id: '',
        hostId: '',
        connected: false,
        peers: {},
        chatMessages: [],
      });
      stopAppStoreSync();
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
        payload: { sessionId: id, user: updatedUser, hostId: get().hostId }
      });
    },

    setSyncNavigation: (enabled) => set({ syncNavigation: enabled }),

    setSyncOverlays: (enabled) => set({ syncOverlays: enabled }),

    broadcastState: (state) => {
      const { connected, id, currentUser, hostId } = get();
      if (!connected || !id) return;

      const ch = getChannel();
      ch.postMessage({
        type: 'state',
        sender: currentUser.id,
        timestamp: Date.now(),
        payload: {
          sessionId: id,
          hostId,
          state,
        },
      });
    },

    sendMessage: (text) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      const { connected, id, currentUser } = get();
      if (!connected || !id) return;

      const message: ChatMessage = {
        id: generateId(),
        senderId: currentUser.id,
        senderName: currentUser.name,
        text: trimmed,
        timestamp: Date.now(),
      };

      set((s) => ({ chatMessages: [...s.chatMessages, message].slice(-CHAT_HISTORY_LIMIT) }));

      const ch = getChannel();
      ch.postMessage({
        type: 'chat',
        sender: currentUser.id,
        timestamp: message.timestamp,
        payload: { sessionId: id, message },
      });
    },

    dispose: () => {
      stopAppStoreSync();
      set({
        id: '',
        hostId: '',
        connected: false,
        peers: {},
        chatMessages: [],
      });
      closeChannel();
    }
  };
});
