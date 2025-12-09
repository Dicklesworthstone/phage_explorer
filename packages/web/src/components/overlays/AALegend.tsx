/**
 * AALegend - Compact amino acid legend
 *
 * Minimal legend showing amino acid colors grouped by property. Designed for
 * embedding or quick reference; smaller than AAKeyOverlay.
 */

import React, { useEffect } from 'react';
import { AMINO_ACIDS, type AminoAcid } from '@phage-explorer/core';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';

const GROUPS: Array<{ id: string; label: string; members: AminoAcid[] }> = [
  { id: 'hydrophobic', label: 'Hydrophobic', members: ['A', 'V', 'L', 'I', 'M', 'F', 'W', 'P'] },
  { id: 'polar', label: 'Polar', members: ['S', 'T', 'Y', 'N', 'Q', 'C'] },
  { id: 'basic', label: 'Basic (+)', members: ['K', 'R', 'H'] },
  { id: 'acidic', label: 'Acidic (-)', members: ['D', 'E'] },
  { id: 'special', label: 'Special', members: ['G', '*'] },
];

export function AALegend(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();

  // Hotkey toggle: Shift+K (uppercase L alternative)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.key === 'L' || e.key === 'l') && e.shiftKey === false && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        toggle('aaLegend');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggle]);

  if (!isOpen('aaLegend')) {
    return null;
  }

  return (
    <Overlay
      id="aaLegend"
      title="AMINO ACID LEGEND"
      icon="🔖"
      hotkey="l"
      size="md"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {GROUPS.map(group => (
          <div key={group.id} style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
            <div style={{ color: colors.primary, fontWeight: 700 }}>{group.label}</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
              {group.members.map(code => {
                const palette = theme.aminoAcids[code];
                const info = AMINO_ACIDS[code];
                return (
                  <div
                    key={code}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      padding: '0.35rem 0.45rem',
                      borderRadius: '4px',
                      backgroundColor: colors.backgroundAlt,
                      border: `1px solid ${colors.borderLight}`,
                    }}
                  >
                    <span
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '28px',
                        height: '28px',
                        borderRadius: '5px',
                        backgroundColor: palette.bg,
                        color: palette.fg,
                        fontWeight: 700,
                        fontSize: '0.95rem',
                      }}
                      aria-label={`${info.name} (${info.threeCode})`}
                    >
                      {code}
                    </span>
                    <span style={{ color: colors.textDim, fontSize: '0.85rem' }}>{info.name}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <div style={{ color: colors.textMuted, fontSize: '0.8rem', textAlign: 'center' }}>
          Compact legend for quick reference. Press L or ESC to close.
        </div>
      </div>
    </Overlay>
  );
}

export default AALegend;

