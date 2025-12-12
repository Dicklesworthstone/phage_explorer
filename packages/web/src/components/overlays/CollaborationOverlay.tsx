import React, { useState } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { useCollaborationStore } from '../../collaboration/CollaborationManager';

export function CollaborationOverlay(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen } = useOverlay();
  
  const connected = useCollaborationStore(s => s.connected);
  const sessionId = useCollaborationStore(s => s.id);
  const peers = useCollaborationStore(s => s.peers);
  const createSession = useCollaborationStore(s => s.createSession);
  const joinSession = useCollaborationStore(s => s.joinSession);
  const leaveSession = useCollaborationStore(s => s.leaveSession);
  
  const [name, setName] = useState('Explorer');
  const [joinId, setJoinId] = useState('');

  if (!isOpen('collaboration')) return null;

  return (
    <Overlay
      id="collaboration"
      title="COLLABORATION"
      icon="👥"
      size="md"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        {!connected ? (
          <>
            <div>
              <label style={{ display: 'block', color: colors.textDim, marginBottom: '0.5rem', fontSize: '0.9rem' }}>
                Your Name
              </label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                style={{
                  width: '100%',
                  padding: '0.75rem',
                  backgroundColor: colors.backgroundAlt,
                  border: `1px solid ${colors.border}`,
                  borderRadius: '4px',
                  color: colors.text,
                }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div style={{ 
                padding: '1rem', 
                border: `1px solid ${colors.border}`, 
                borderRadius: '4px',
                textAlign: 'center' 
              }}>
                <h3 style={{ color: colors.primary, marginTop: 0 }}>New Session</h3>
                <p style={{ fontSize: '0.85rem', color: colors.textMuted }}>Start a new collaborative room</p>
                <button
                  onClick={() => createSession(name)}
                  style={{
                    marginTop: '1rem',
                    padding: '0.5rem 1rem',
                    backgroundColor: colors.primary,
                    color: '#000',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontWeight: 'bold',
                    width: '100%'
                  }}
                >
                  Create
                </button>
              </div>

              <div style={{ 
                padding: '1rem', 
                border: `1px solid ${colors.border}`, 
                borderRadius: '4px',
                textAlign: 'center' 
              }}>
                <h3 style={{ color: colors.secondary, marginTop: 0 }}>Join Session</h3>
                <input
                  type="text"
                  placeholder="Session ID"
                  value={joinId}
                  onChange={e => setJoinId(e.target.value)}
                  style={{
                    width: '100%',
                    padding: '0.5rem',
                    marginBottom: '0.5rem',
                    backgroundColor: colors.background,
                    border: `1px solid ${colors.borderLight}`,
                    borderRadius: '4px',
                    color: colors.text,
                    fontSize: '0.9rem'
                  }}
                />
                <button
                  onClick={() => joinSession(joinId, name)}
                  disabled={!joinId}
                  style={{
                    padding: '0.5rem 1rem',
                    backgroundColor: colors.secondary,
                    color: '#fff',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: joinId ? 'pointer' : 'not-allowed',
                    width: '100%',
                    opacity: joinId ? 1 : 0.5
                  }}
                >
                  Join
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="animate-fade-in">
            <div style={{ 
              backgroundColor: colors.backgroundAlt, 
              padding: '1rem', 
              borderRadius: '4px',
              marginBottom: '1rem',
              borderLeft: `3px solid ${colors.success}`
            }}>
              <div style={{ color: colors.textDim, fontSize: '0.85rem' }}>Session ID</div>
              <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                {sessionId}
                <button
                  onClick={() => navigator.clipboard.writeText(sessionId)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: colors.accent,
                    cursor: 'pointer',
                    fontSize: '0.8rem'
                  }}
                >
                  Copy
                </button>
              </div>
            </div>

            <h3 style={{ color: colors.text, fontSize: '1rem', marginBottom: '0.5rem' }}>
              Active Peers ({Object.keys(peers).length})
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {Object.values(peers).map(peer => (
                <div key={peer.id} style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '0.75rem',
                  padding: '0.5rem',
                  backgroundColor: colors.background,
                  borderRadius: '4px',
                  border: `1px solid ${colors.borderLight}`
                }}>
                  <div style={{ 
                    width: '10px', 
                    height: '10px', 
                    borderRadius: '50%', 
                    backgroundColor: peer.color 
                  }} />
                  <span style={{ color: colors.text }}>{peer.name}</span>
                  {peer.id === useCollaborationStore.getState().currentUser.id && (
                    <span style={{ color: colors.textMuted, fontSize: '0.8rem' }}>(You)</span>
                  )}
                </div>
              ))}
            </div>

            <button
              onClick={leaveSession}
              style={{
                marginTop: '2rem',
                padding: '0.5rem 1rem',
                backgroundColor: 'transparent',
                border: `1px solid ${colors.error}`,
                color: colors.error,
                borderRadius: '4px',
                cursor: 'pointer',
                width: '100%'
              }}
            >
              Leave Session
            </button>
          </div>
        )}
      </div>
    </Overlay>
  );
}
