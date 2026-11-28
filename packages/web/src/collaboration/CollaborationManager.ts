/** Opt-in collaboration between tabs on this browser origin. */
import { create } from 'zustand';
import type { SessionId, UserPresence, SyncMessage, SessionState } from './types';
import type { SavedView } from '../../../core/src/saved-views';
import type { BrowserNavigationSession } from '../hooks/BrowserNavigationSession';
import { normalizeShareableOverlayId, type ShareableOverlayId } from '../utils/share-state';

const generateId = () => globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
const generateColor = () => `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`;

interface SharedAppState {
  fingerprint: string;
  navigation?: SavedView;
  tool?: ShareableOverlayId | null;
}
export interface CollaborationExplorer {
  navigation: Pick<BrowserNavigationSession, 'currentCatalogView' | 'followCatalogView' | 'subscribe'>;
  currentTool: () => ShareableOverlayId | null;
  showTool: (tool: ShareableOverlayId | null) => void;
}
export type ChatMessage = { id: string; senderId: string; senderName: string; text: string; timestamp: number };

interface CollaborationStore extends SessionState {
  currentUser: UserPresence;
  chatMessages: ChatMessage[];
  syncNavigation: boolean;
  syncOverlays: boolean;
  syncNotice: string | null;
  attachExplorer: (explorer: CollaborationExplorer) => () => void;
  explorerChanged: () => void;
  createSession: (name: string) => Promise<SessionId>;
  joinSession: (sessionId: SessionId, name: string) => Promise<void>;
  leaveSession: () => void;
  updatePresence: (presence: Partial<UserPresence>) => void;
  setSyncNavigation: (enabled: boolean) => void;
  setSyncOverlays: (enabled: boolean) => void;
  sendMessage: (text: string) => void;
  dispose: () => void;
}

const CHAT_HISTORY_LIMIT = 200;
const STATE_BROADCAST_THROTTLE_MS = 50;

function hostOf(peers: Record<string, UserPresence>): string {
  return Object.values(peers).sort((a, b) =>
    (a.joinedAt ?? a.lastActive) - (b.joinedAt ?? b.lastActive) || a.id.localeCompare(b.id))[0]?.id ?? '';
}

export const createCollaborationStore = () => create<CollaborationStore>((set, get) => {
  let channel: BroadcastChannel | null = null;
  let explorer: CollaborationExplorer | null = null;
  let unsubscribe: (() => void) | undefined;
  let following: AbortController | null = null;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let lastSent: string | undefined;
  let joinedWithoutView = false;

  const snapshot = (): SharedAppState | null => {
    const { syncNavigation, syncOverlays } = get();
    const view = explorer?.navigation.currentCatalogView();
    if (!view || !explorer || (!syncNavigation && !syncOverlays)) return null;
    return { fingerprint: view.source.fingerprint, ...(syncNavigation && { navigation: view }),
      ...(syncOverlays && { tool: explorer.currentTool() }) };
  };
  const post = (type: SyncMessage['type'], body: Record<string, unknown>) => {
    const { id, currentUser } = get();
    channel?.postMessage({ type, sender: currentUser.id, timestamp: Date.now(), payload: { ...body, sessionId: id } });
  };
  const stopFollowing = () => { following?.abort(); following = null; };
  // Re-read at send time. A private workspace, newer viewport or disabled switch
  // can replace a public view while the outbound timer is waiting.
  const explorerChanged = () => {
    if (!channel || pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      const state = snapshot();
      if (!state || following) return;
      const json = JSON.stringify(state);
      if (joinedWithoutView) {
        joinedWithoutView = false;
        const group = get();
        if (group.hostId !== group.currentUser.id) {
          // We could not consume the welcome snapshot while the catalog was loading.
          // Ask for a fresh one before publishing the default viewport to the room.
          lastSent = json;
          post('join', { user: group.currentUser }); return;
        }
      }
      if (json !== lastSent) { lastSent = json; post('state', { state }); }
    }, STATE_BROADCAST_THROTTLE_MS);
  };
  const applyRemote = async (state: SharedAppState) => {
    const tab = explorer, { syncNavigation, syncOverlays } = get();
    if (!tab || !state || typeof state.fingerprint !== 'string' ||
        !/^[a-f0-9]{64}$/.test(state.fingerprint) || (!syncNavigation && !syncOverlays)) return;
    if (state.navigation && (state.navigation.source?.kind !== 'catalog' ||
        state.navigation.source.fingerprint !== state.fingerprint)) return;
    const hasSharedTool = state.tool === null ||
      (typeof state.tool === 'string' && normalizeShareableOverlayId(state.tool) === state.tool);
    if ((!syncNavigation || !state.navigation) && (!syncOverlays || !hasSharedTool)) return;
    stopFollowing();
    const origin = tab.navigation.currentCatalogView();
    if (!origin) return; // A private workspace or a foreground selection owns the explorer.
    const owner = new AbortController();
    following = owner;
    try {
      if (syncNavigation && state.navigation) {
        const accepted = await tab.navigation.followCatalogView(state.navigation, owner.signal);
        if (following !== owner) return;
        if (!accepted) { set({ syncNotice: 'The shared view could not be applied to the current catalog or navigation.' }); return; }
      }
      if (tab.navigation.currentCatalogView()?.source.fingerprint !== state.fingerprint) return;
      if (syncOverlays && hasSharedTool) {
        tab.showTool(state.tool ?? null);
      }
      // Suppress only the accepted remote state. A newer local edit remains eligible.
      const result = snapshot();
      if (result) {
        if (syncNavigation && state.navigation) result.navigation = state.navigation;
        if (syncOverlays && hasSharedTool) result.tool = state.tool;
        lastSent = JSON.stringify(result);
      }
      set({ syncNotice: null });
    } catch {
      if (following === owner) set({ syncNotice: 'The shared catalog view is unavailable.' });
    } finally {
      if (following === owner) { following = null; explorerChanged(); }
    }
  };

  const receive = (event: MessageEvent<SyncMessage>) => {
    const msg = event.data, state = get();
    if (!msg || !state.connected || msg.payload?.sessionId !== state.id ||
        typeof msg.sender !== 'string' || msg.sender === state.currentUser.id) return;
    if (msg.type === 'join' || msg.type === 'presence') {
      const peer: UserPresence = msg.payload.user;
      if (!peer || peer.id !== msg.sender || typeof peer.name !== 'string' || !Number.isFinite(peer.lastActive)) return;
      const peers = { ...state.peers, [peer.id]: peer }, hostId = hostOf(peers);
      set({ peers, hostId });
      if (msg.type === 'join') {
        post('presence', { user: get().currentUser });
        const initial = hostId === state.currentUser.id ? snapshot() : null;
        if (initial) post('state', { target: msg.sender, state: initial });
      }
    } else if (msg.type === 'state') {
      if (!msg.payload.target || msg.payload.target === state.currentUser.id) void applyRemote(msg.payload.state);
    } else if (msg.type === 'chat') {
      const message = msg.payload.message as ChatMessage | undefined;
      if (message?.senderId === msg.sender && typeof message.text === 'string' && !state.chatMessages.some(m => m.id === message.id)) {
        set({ chatMessages: [...state.chatMessages, message].slice(-CHAT_HISTORY_LIMIT) });
      }
    } else if (msg.type === 'leave') {
      const peers = { ...state.peers };
      delete peers[msg.sender];
      set({ peers, hostId: hostOf(peers) });
    }
  };

  const leave = () => {
    if (channel) {
      try { post('leave', {}); } catch { /* The document may already be closing. */ }
      channel.close(); channel = null;
    }
    if (pending !== null) clearTimeout(pending);
    pending = null; lastSent = undefined;
    stopFollowing();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', leave);
    set({ id: '', hostId: '', peers: {}, chatMessages: [], connected: false, syncNotice: null });
  };
  const join = async (sessionId: string, name: string) => {
    leave();
    if (typeof BroadcastChannel === 'undefined') {
      set({ syncNotice: 'This browser does not support local tab synchronization.' }); return;
    }
    channel = new BroadcastChannel('phage_explorer_collab');
    channel.onmessage = receive;
    const joinedAt = Date.now(), user = { ...get().currentUser, name, joinedAt, lastActive: joinedAt };
    set({ id: sessionId, currentUser: user, peers: { [user.id]: user }, hostId: user.id, connected: true });
    lastSent = JSON.stringify(snapshot());
    joinedWithoutView = !explorer?.navigation.currentCatalogView();
    if (typeof window !== 'undefined') window.addEventListener('pagehide', leave);
    post('join', { user });
    post('presence', { user });
  };
  return {
    id: '', hostId: '', peers: {}, connected: false, chatMessages: [], syncNavigation: true, syncOverlays: false, syncNotice: null,
    currentUser: { id: generateId(), name: 'Anonymous', color: generateColor(), lastActive: Date.now() },
    attachExplorer: next => {
      unsubscribe?.(); stopFollowing(); explorer = next;
      unsubscribe = next.navigation.subscribe(explorerChanged);
      explorerChanged();
      return () => {
        if (explorer === next) { explorer = null; unsubscribe?.(); unsubscribe = undefined; stopFollowing(); }
      };
    },
    explorerChanged,
    createSession: async name => { const id = generateId(); await join(id, name); return id; },
    joinSession: join,
    leaveSession: leave,
    updatePresence: ({ name, color }) => {
      const { currentUser, connected, peers } = get();
      if (!connected) return;
      const user = { ...currentUser, name: name ?? currentUser.name, color: color ?? currentUser.color, lastActive: Date.now() };
      set({ currentUser: user, peers: { ...peers, [user.id]: user } });
      post('presence', { user });
    },
    setSyncNavigation: enabled => { stopFollowing(); set({ syncNavigation: enabled }); explorerChanged(); },
    setSyncOverlays: enabled => { stopFollowing(); set({ syncOverlays: enabled }); explorerChanged(); },
    sendMessage: text => {
      const { currentUser, connected, chatMessages } = get();
      if (!connected || !text.trim()) return;
      const message = { id: generateId(), senderId: currentUser.id, senderName: currentUser.name,
        text: text.trim(), timestamp: Date.now() };
      set({ chatMessages: [...chatMessages, message].slice(-CHAT_HISTORY_LIMIT) });
      post('chat', { message });
    },
    dispose: leave,
  };
});

export const useCollaborationStore = createCollaborationStore();
