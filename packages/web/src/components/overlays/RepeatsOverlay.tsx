/**
 * RepeatsOverlay - Repeat & Palindrome Finder
 *
 * Displays direct repeats, inverted repeats, and palindromic sequences.
 */

import React, { useEffect, useMemo } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';

interface RepeatsOverlayProps {
  sequence?: string;
}

interface RepeatInfo {
  type: 'direct' | 'inverted' | 'palindrome';
  position1: number;
  position2?: number;
  sequence: string;
  length: number;
}

// Reverse complement
function reverseComplement(seq: string): string {
  const complement: Record<string, string> = { A: 'T', T: 'A', C: 'G', G: 'C' };
  return seq.split('').reverse().map(c => complement[c] || c).join('');
}

// Find repeats in sequence
function findRepeats(sequence: string, minLength = 8, maxGap = 5000): RepeatInfo[] {
  const repeats: RepeatInfo[] = [];
  const seq = sequence.toUpperCase();

  // Sample positions for efficiency
  const step = Math.max(1, Math.floor(seq.length / 500));

  for (let i = 0; i < seq.length - minLength; i += step) {
    const pattern = seq.slice(i, i + minLength);
    if (/[^ACGT]/.test(pattern)) continue;

    // Look for direct repeats
    const searchStart = Math.min(i + minLength, seq.length);
    const searchEnd = Math.min(i + maxGap, seq.length);
    const searchRegion = seq.slice(searchStart, searchEnd);

    let idx = searchRegion.indexOf(pattern);
    if (idx !== -1 && repeats.length < 50) {
      repeats.push({
        type: 'direct',
        position1: i,
        position2: searchStart + idx,
        sequence: pattern,
        length: minLength,
      });
    }

    // Look for inverted repeats
    const revComp = reverseComplement(pattern);
    idx = searchRegion.indexOf(revComp);
    if (idx !== -1 && repeats.length < 50) {
      repeats.push({
        type: 'inverted',
        position1: i,
        position2: searchStart + idx,
        sequence: pattern,
        length: minLength,
      });
    }

    // Check if palindrome (self-complementary)
    if (pattern === revComp && repeats.length < 50) {
      repeats.push({
        type: 'palindrome',
        position1: i,
        sequence: pattern,
        length: minLength,
      });
    }
  }

  return repeats;
}

export function RepeatsOverlay({ sequence = '' }: RepeatsOverlayProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  const repeats = useMemo(() => findRepeats(sequence), [sequence]);
  const direct = repeats.filter(r => r.type === 'direct');
  const inverted = repeats.filter(r => r.type === 'inverted');
  const palindromes = repeats.filter(r => r.type === 'palindrome');

  // Register hotkey
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'r' || e.key === 'R') && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        e.preventDefault();
        toggle('repeats');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle]);

  if (!isOpen('repeats')) {
    return null;
  }

  const typeColors = {
    direct: colors.primary,
    inverted: colors.warning,
    palindrome: colors.accent,
  };

  const typeIcons = {
    direct: '→→',
    inverted: '→←',
    palindrome: '↔',
  };

  return (
    <Overlay
      id="repeats"
      title="REPEATS & PALINDROMES"
      icon="🔄"
      hotkey="r"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Description */}
        <div style={{
          padding: '0.75rem',
          backgroundColor: colors.backgroundAlt,
          borderRadius: '4px',
          color: colors.textDim,
          fontSize: '0.9rem',
        }}>
          <strong style={{ color: colors.primary }}>Repeat Analysis</strong> identifies direct repeats,
          inverted repeats (potential hairpins), and palindromic sequences that may play regulatory roles.
        </div>

        {/* Stats */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: '1rem',
        }}>
          <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
            <div style={{ color: colors.primary, fontSize: '0.75rem' }}>Direct Repeats</div>
            <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.5rem' }}>{direct.length}</div>
          </div>
          <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
            <div style={{ color: colors.warning, fontSize: '0.75rem' }}>Inverted Repeats</div>
            <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.5rem' }}>{inverted.length}</div>
          </div>
          <div style={{ textAlign: 'center', padding: '0.75rem', backgroundColor: colors.backgroundAlt, borderRadius: '4px' }}>
            <div style={{ color: colors.accent, fontSize: '0.75rem' }}>Palindromes</div>
            <div style={{ color: colors.text, fontFamily: 'monospace', fontSize: '1.5rem' }}>{palindromes.length}</div>
          </div>
        </div>

        {/* Repeats table */}
        <div style={{
          maxHeight: '300px',
          overflowY: 'auto',
          border: `1px solid ${colors.borderLight}`,
          borderRadius: '4px',
        }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
            <thead>
              <tr style={{ backgroundColor: colors.backgroundAlt, position: 'sticky', top: 0 }}>
                <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Type</th>
                <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Position(s)</th>
                <th style={{ padding: '0.5rem', textAlign: 'left', color: colors.textDim }}>Sequence</th>
                <th style={{ padding: '0.5rem', textAlign: 'right', color: colors.textDim }}>Length</th>
              </tr>
            </thead>
            <tbody>
              {repeats.map((repeat, idx) => (
                <tr
                  key={idx}
                  style={{
                    borderTop: `1px solid ${colors.borderLight}`,
                    backgroundColor: idx % 2 === 0 ? 'transparent' : colors.backgroundAlt,
                  }}
                >
                  <td style={{ padding: '0.5rem' }}>
                    <span style={{ color: typeColors[repeat.type], fontWeight: 'bold' }}>
                      {typeIcons[repeat.type]} {repeat.type.charAt(0).toUpperCase() + repeat.type.slice(1)}
                    </span>
                  </td>
                  <td style={{ padding: '0.5rem', fontFamily: 'monospace', color: colors.text }}>
                    {repeat.position1.toLocaleString()}
                    {repeat.position2 && ` ↔ ${repeat.position2.toLocaleString()}`}
                  </td>
                  <td style={{ padding: '0.5rem', fontFamily: 'monospace', color: colors.accent }}>
                    {repeat.sequence}
                  </td>
                  <td style={{ padding: '0.5rem', textAlign: 'right', color: colors.textDim }}>
                    {repeat.length} bp
                  </td>
                </tr>
              ))}
              {repeats.length === 0 && (
                <tr>
                  <td colSpan={4} style={{ padding: '2rem', textAlign: 'center', color: colors.textMuted }}>
                    No repeats found
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Legend */}
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          gap: '2rem',
          color: colors.textMuted,
          fontSize: '0.85rem',
        }}>
          <span><span style={{ color: colors.primary }}>→→</span> Direct (same strand)</span>
          <span><span style={{ color: colors.warning }}>→←</span> Inverted (hairpin)</span>
          <span><span style={{ color: colors.accent }}>↔</span> Palindrome (self-complementary)</span>
        </div>

        {sequence.length === 0 && (
          <div style={{ textAlign: 'center', padding: '2rem', color: colors.textMuted }}>
            No sequence data available.
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default RepeatsOverlay;
