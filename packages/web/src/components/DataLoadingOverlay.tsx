/**
 * DataLoadingOverlay - Database Loading Screen
 *
 * Displays progress while loading the SQLite database.
 */

import React from 'react';
import { useTheme } from '../../hooks/useTheme';
import type { DatabaseLoadProgress } from '../../db';

interface DataLoadingOverlayProps {
  progress: DatabaseLoadProgress | null;
  error?: string | null;
  onRetry?: () => void;
}

export function DataLoadingOverlay({
  progress,
  error,
  onRetry,
}: DataLoadingOverlayProps): React.ReactElement {
  const { theme } = useTheme();
  const colors = theme.colors;

  if (error) {
    return (
      <div style={{
        position: 'fixed',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.background,
        zIndex: 9999,
      }}>
        <div style={{
          border: `1px solid ${colors.error}`,
          padding: '2rem',
          borderRadius: '8px',
          textAlign: 'center',
          backgroundColor: 'rgba(255, 0, 0, 0.1)',
        }}>
          <div style={{ fontSize: '2rem', marginBottom: '1rem' }}>⚠️</div>
          <h2 style={{ color: colors.error, marginBottom: '1rem' }}>Database Load Failed</h2>
          <p style={{ color: colors.text, marginBottom: '1.5rem' }}>{error}</p>
          {onRetry && (
            <button
              onClick={onRetry}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: colors.primary,
                color: '#000',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontWeight: 'bold',
              }}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!progress) return <div />;

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background,
      zIndex: 9999,
    }}>
      <div style={{ width: '300px', textAlign: 'center' }}>
        <div style={{ marginBottom: '1rem', fontSize: '1.5rem', color: colors.accent }}>
          PHAGE EXPLORER
        </div>
        
        <div style={{ 
          height: '4px', 
          backgroundColor: colors.border,
          borderRadius: '2px',
          marginBottom: '1rem',
          overflow: 'hidden'
        }}>
          <div style={{
            height: '100%',
            width: `${progress.percent}%`,
            backgroundColor: colors.primary,
            transition: 'width 0.2s ease',
          }} />
        </div>

        <div style={{ color: colors.textDim, fontSize: '0.9rem' }}>
          {progress.message} ({progress.percent}%)
        </div>
      </div>
    </div>
  );
}
