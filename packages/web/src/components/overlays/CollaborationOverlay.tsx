import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { useCollaborationStore } from '../../collaboration/CollaborationManager';

export function CollaborationOverlay(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen } = useOverlay();

  const connected = useCollaborationStore((s) => s.connected);
  const activeGroupId = useCollaborationStore((s) => s.id);
  const hostId = useCollaborationStore((s) => s.hostId);
  const peers = useCollaborationStore((s) => s.peers);
  const currentUserId = useCollaborationStore((s) => s.currentUser.id);
  const joinSession = useCollaborationStore((s) => s.joinSession);
  const leaveSession = useCollaborationStore((s) => s.leaveSession);
  const chatMessages = useCollaborationStore((s) => s.chatMessages);
  const sendMessage = useCollaborationStore((s) => s.sendMessage);
  const syncNavigation = useCollaborationStore((s) => s.syncNavigation);
  const syncOverlays = useCollaborationStore((s) => s.syncOverlays);
  const setSyncNavigation = useCollaborationStore((s) => s.setSyncNavigation);
  const setSyncOverlays = useCollaborationStore((s) => s.setSyncOverlays);

  const [tabLabel, setTabLabel] = useState('Tab 1');
  const [roomName, setRoomName] = useState('local-workspace');
  const [messageDraft, setMessageDraft] = useState('');
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const sortedPeers = useMemo(() => {
    const list = Object.values(peers);
    return list.sort((a, b) => {
      if (hostId && Object.is(a.id, hostId)) return -1;
      if (hostId && Object.is(b.id, hostId)) return 1;
      return a.name.localeCompare(b.name);
    });
  }, [peers, hostId]);

  const hasChatMessages = chatMessages.length > 0;

  useEffect(() => {
    if (!connected) return;
    chatEndRef.current?.scrollIntoView({ block: 'end' });
  }, [connected, chatMessages.length]);

  if (!isOpen('collaboration')) return null;

  return (
    <Overlay
      id="collaboration"
      title="MULTI-TAB SYNC"
      size="md"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <div
          style={{
            fontSize: '0.85rem',
            color: colors.textDim,
            lineHeight: 1.45,
            backgroundColor: colors.backgroundAlt,
            padding: '0.75rem 1rem',
            borderRadius: '4px',
            borderLeft: `3px solid ${colors.primary}`,
          }}
        >
          Synchronize phage selection, viewport coordinates, and active overlays across browser
          tabs open on this device via local <code style={{ color: colors.text }}>BroadcastChannel</code>.
        </div>

        {!connected ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div>
              <label
                htmlFor="collab-tab-label"
                style={{ display: 'block', color: colors.textDim, marginBottom: '0.4rem', fontSize: '0.85rem' }}
              >
                Tab Label
              </label>
              <input
                id="collab-tab-label"
                type="text"
                value={tabLabel}
                onChange={(e) => setTabLabel(e.target.value)}
                placeholder="e.g. Tab 1 or View A"
                style={{
                  width: '100%',
                  padding: '0.6rem 0.75rem',
                  backgroundColor: colors.background,
                  border: `1px solid ${colors.border}`,
                  borderRadius: '4px',
                  color: colors.text,
                  fontSize: '0.9rem',
                }}
              />
            </div>

            <div>
              <label
                htmlFor="collab-sync-group"
                style={{ display: 'block', color: colors.textDim, marginBottom: '0.4rem', fontSize: '0.85rem' }}
              >
                Sync Group
              </label>
              <input
                id="collab-sync-group"
                type="text"
                value={roomName}
                onChange={(e) => setRoomName(e.target.value)}
                placeholder="local-workspace"
                style={{
                  width: '100%',
                  padding: '0.6rem 0.75rem',
                  backgroundColor: colors.background,
                  border: `1px solid ${colors.border}`,
                  borderRadius: '4px',
                  color: colors.text,
                  fontSize: '0.9rem',
                }}
              />
              <span style={{ fontSize: '0.75rem', color: colors.textMuted, display: 'block', marginTop: '0.3rem' }}>
                Tabs with the same sync group name share state automatically.
              </span>
            </div>

            <button
              type="button"
              onClick={() => joinSession(roomName.trim() || 'local-workspace', tabLabel.trim() || 'Tab 1')}
              style={{
                marginTop: '0.5rem',
                padding: '0.75rem 1rem',
                backgroundColor: colors.primary,
                color: '#000',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 700,
                fontSize: '0.95rem',
                width: '100%',
              }}
            >
              Connect Multi-Tab Sync
            </button>
          </div>
        ) : (
          <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div
              style={{
                backgroundColor: colors.backgroundAlt,
                padding: '0.75rem 1rem',
                borderRadius: '4px',
                borderLeft: `3px solid ${colors.success}`,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <div>
                <div style={{ color: colors.textDim, fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  Sync Group
                </div>
                <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.1rem', fontWeight: 600 }}>
                  {activeGroupId}
                </div>
              </div>
              <div
                style={{
                  padding: '0.25rem 0.6rem',
                  borderRadius: '12px',
                  backgroundColor: `${colors.success}22`,
                  color: colors.success,
                  fontSize: '0.8rem',
                  fontWeight: 600,
                }}
              >
                ● Connected
              </div>
            </div>

            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
              <label
                key="sync-nav-option"
                style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', color: colors.text, fontSize: '0.85rem', cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={syncNavigation}
                  onChange={(e) => setSyncNavigation(e.target.checked)}
                />
                Sync navigation (phage, scroll, view mode)
              </label>
              <label
                key="sync-overlays-option"
                style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', color: colors.text, fontSize: '0.85rem', cursor: 'pointer' }}
              >
                <input
                  type="checkbox"
                  checked={syncOverlays}
                  onChange={(e) => setSyncOverlays(e.target.checked)}
                />
                Sync active overlays
              </label>
            </div>

            <div>
              <h3 style={{ color: colors.text, fontSize: '0.9rem', marginBottom: '0.5rem', fontWeight: 600 }}>
                Active Tabs in Group ({Object.keys(peers).length})
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {sortedPeers.map((peer) => {
                  const isCurrent = Object.is(peer.id, currentUserId);
                  const isHost = hostId ? Object.is(peer.id, hostId) && !isCurrent : false;
                  return (
                    <div
                      key={peer.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.75rem',
                        padding: '0.5rem 0.75rem',
                        backgroundColor: colors.backgroundAlt,
                        borderRadius: '4px',
                        border: `1px solid ${colors.borderLight}`,
                      }}
                    >
                      <div
                        key={`badge-${peer.id}`}
                        style={{
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          backgroundColor: peer.color,
                        }}
                      />
                      <span style={{ color: colors.text, fontSize: '0.85rem', fontWeight: 500 }}>{peer.name}</span>
                      {isCurrent && (
                        <span style={{ color: colors.textMuted, fontSize: '0.75rem' }}>(This Tab)</span>
                      )}
                      {isHost && (
                        <span style={{ color: colors.textMuted, fontSize: '0.75rem' }}>(Host Tab)</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div>
              <h3 style={{ color: colors.text, fontSize: '0.9rem', marginBottom: '0.5rem', fontWeight: 600 }}>
                Cross-Tab Notes & Messages
              </h3>
              <div
                style={{
                  maxHeight: '180px',
                  overflowY: 'auto',
                  backgroundColor: colors.backgroundAlt,
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '4px',
                  padding: '0.6rem 0.75rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.4rem',
                }}
              >
                {!hasChatMessages ? (
                  <div style={{ color: colors.textMuted, fontSize: '0.8rem' }}>
                    No cross-tab messages yet. Send a note to share findings across tabs.
                  </div>
                ) : (
                  chatMessages.map((m) => (
                    <div key={m.id} style={{ display: 'flex', gap: '0.5rem', alignItems: 'baseline', fontSize: '0.85rem' }}>
                      <span style={{ color: colors.textDim, fontSize: '0.75rem', fontFamily: 'monospace' }}>
                        {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <span style={{ color: colors.text, fontWeight: 600 }}>{m.senderName}:</span>
                      <span style={{ color: colors.text }}>{m.text}</span>
                    </div>
                  ))
                )}
                <div ref={chatEndRef} key="chat-scroll-anchor" />
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!messageDraft.trim()) return;
                  sendMessage(messageDraft);
                  setMessageDraft('');
                }}
                style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem' }}
              >
                <label htmlFor="collab-chat-message" className="sr-only">
                  Cross-tab note
                </label>
                <input
                  key="chat-input-field"
                  id="collab-chat-message"
                  type="text"
                  value={messageDraft}
                  onChange={(e) => setMessageDraft(e.target.value)}
                  placeholder="Share a note across tabs..."
                  style={{
                    flex: 1,
                    padding: '0.5rem 0.75rem',
                    backgroundColor: colors.background,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '4px',
                    color: colors.text,
                    fontSize: '0.85rem',
                  }}
                />
                <button
                  type="submit"
                  disabled={!messageDraft.trim()}
                  style={{
                    padding: '0.5rem 0.9rem',
                    backgroundColor: colors.accent,
                    color: '#000',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: messageDraft.trim() ? 'pointer' : 'not-allowed',
                    opacity: messageDraft.trim() ? 1 : 0.6,
                    fontWeight: 600,
                    fontSize: '0.85rem',
                  }}
                >
                  Send
                </button>
              </form>
            </div>

            <button
              type="button"
              onClick={leaveSession}
              style={{
                marginTop: '0.5rem',
                padding: '0.5rem 1rem',
                backgroundColor: 'transparent',
                border: `1px solid ${colors.error}`,
                color: colors.error,
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '0.85rem',
                width: '100%',
              }}
            >
              Disconnect Tab
            </button>
          </div>
        )}
      </div>
    </Overlay>
  );
}
