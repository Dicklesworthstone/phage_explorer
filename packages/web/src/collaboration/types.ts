/**
 * Collaboration Types
 */

export type PeerId = string;
export type SessionId = string;

export interface UserPresence {
  id: PeerId;
  name: string;
  color: string;
  cursor?: { x: number; y: number };
  selection?: { start: number; end: number };
  view?: {
    phageId: number;
    position: number;
  };
  lastActive: number;
}

export interface SyncMessage {
  type: 'presence' | 'state' | 'chat';
  sender: PeerId;
  timestamp: number;
  payload: any;
}

export interface SessionState {
  id: SessionId;
  hostId: PeerId;
  peers: Record<PeerId, UserPresence>;
  connected: boolean;
}

export interface SignalingMessage {
  type: 'offer' | 'answer' | 'candidate' | 'join' | 'leave';
  target?: PeerId;
  sender: PeerId;
  payload?: any;
}
