/**
 * GotoOverlay - Jump to genome coordinate
 *
 * Provides a quick, keyboard-first way to jump to a nucleotide index or percentage.
 * Mirrors the inline jump control in SequenceView, but is accessible via a global hotkey.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { OverlayEmptyState, OverlayStack } from './primitives';

function parseGotoTarget(raw: string, sequenceLength: number): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const value = trimmed.includes('-') ? trimmed.split('-')[0]?.trim() ?? '' : trimmed;

  if (value.endsWith('%')) {
    const pctRaw = value.slice(0, -1).trim();
    const pct = Number.parseFloat(pctRaw);
    if (!Number.isFinite(pct)) return null;
    const clampedPct = Math.max(0, Math.min(100, pct));
    return Math.floor((clampedPct / 100) * sequenceLength);
  }

  const idx = Number.parseInt(value, 10);
  if (!Number.isFinite(idx)) return null;
  return idx;
}

export function GotoOverlay(): React.ReactElement | null {
  const { isOpen, close } = useOverlay();
  const overlayOpen = isOpen('goto');

  const currentPhage = usePhageStore((s) => s.currentPhage);
  const viewMode = usePhageStore((s) => s.viewMode);
  const readingFrame = usePhageStore((s) => s.readingFrame);
  const setScrollPosition = usePhageStore((s) => s.setScrollPosition);

  const [input, setInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const genomeLength = currentPhage?.genomeLength ?? 0;
  const displayLength = useMemo(() => {
    if (!genomeLength) return 0;
    if (viewMode !== 'aa') return genomeLength;
    const frameOffset = (readingFrame < 0 ? Math.abs(readingFrame) - 1 : readingFrame) as 0 | 1 | 2;
    return Math.max(0, Math.floor((genomeLength - frameOffset) / 3));
  }, [genomeLength, readingFrame, viewMode]);

  const helpText = useMemo(() => {
    const length = displayLength > 0 ? displayLength.toLocaleString() : '—';
    const unit = viewMode === 'aa' ? 'codon index' : 'nucleotide index';
    return `Enter an ${unit} or a percentage of the genome (length: ${length}).`;
  }, [displayLength, viewMode]);

  const handleClose = useCallback(() => {
    setError(null);
    setInput('');
    close('goto');
  }, [close]);

  const handleGo = useCallback(() => {
    if (!displayLength) return;
    const target = parseGotoTarget(input, displayLength);
    if (target === null) {
      setError('Enter a number like 12000, a percent like 25%, or a range like 1000-2000.');
      return;
    }

    const clamped = Math.max(0, Math.min(displayLength - 1, target));
    setScrollPosition(clamped);
    handleClose();
  }, [displayLength, handleClose, input, setScrollPosition]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      handleGo();
    }
    if (e.key === 'Escape') {
      if (input.trim()) {
        e.preventDefault();
        setInput('');
        setError(null);
        return;
      }
      // Let OverlayProvider close on Escape when empty.
      setError(null);
    }
  }, [handleGo, input]);

  if (!overlayOpen) {
    return null;
  }

  if (!currentPhage || genomeLength <= 0) {
    return (
      <Overlay id="goto" title="GO TO POSITION" hotkey="Ctrl+G" size="sm" onClose={handleClose}>
        <OverlayStack>
          <OverlayEmptyState
            message="Select a phage to jump."
            hint="Pick a phage first, then reopen Go To to jump to genome coordinates."
            action={
              <button type="button" className="btn btn-ghost" onClick={handleClose}>
                Close
              </button>
            }
          />
        </OverlayStack>
      </Overlay>
    );
  }

  return (
    <Overlay id="goto" title="GO TO POSITION" hotkey="Ctrl+G" size="sm" onClose={handleClose}>
      <OverlayStack>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <label htmlFor="goto-coordinate" style={{ color: 'var(--color-text-dim)', fontSize: 'var(--text-sm)' }}>
            Coordinate
          </label>
          <input
            id="goto-coordinate"
            data-overlay-autofocus="true"
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              if (error) setError(null);
            }}
            onKeyDown={handleKeyDown}
            placeholder={viewMode === 'aa' ? 'e.g. 4000 or 25%' : 'e.g. 12000 or 25%'}
            style={{
              padding: '0.75rem',
              minHeight: '48px',
              fontSize: '16px', // Prevents iOS zoom on focus
              borderRadius: '6px',
              border: '1px solid var(--color-border)',
              background: 'var(--color-background-alt)',
              color: 'var(--color-text)',
            }}
          />
          <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={handleClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={handleGo}>
              Go
            </button>
          </div>
          <div style={{ color: 'var(--color-text-muted)', fontSize: 'var(--text-xs)', lineHeight: 1.5 }}>
            {helpText}
          </div>
          {error && (
            <div role="alert" style={{ color: 'var(--color-danger, #ef4444)', fontSize: 'var(--text-xs)' }}>
              {error}
            </div>
          )}
        </div>
      </OverlayStack>
    </Overlay>
  );
}

export default GotoOverlay;
