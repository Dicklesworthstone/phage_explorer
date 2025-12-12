/**
 * AminoAcidHUD - Educational Touch Overlay
 *
 * Displays detailed amino acid information when users tap and hold
 * on an amino acid in the sequence view. Designed for non-specialists
 * to learn about protein building blocks.
 */

import React, { useEffect, useRef } from 'react';
import {
  getAminoAcidInfo,
  getClassificationLabel,
  getClassificationColor,
  getRnaCodons,
} from '@phage-explorer/core';
import { useTheme } from '../hooks/useTheme';

export interface AminoAcidHUDProps {
  /** Single letter amino acid code */
  aminoAcid: string | null;
  /** Position to display the HUD */
  position: { x: number; y: number } | null;
  /** Whether the HUD is visible */
  visible: boolean;
}

/**
 * Format molecular formula with proper subscripts
 */
function formatFormula(formula: string): React.ReactNode {
  // Already has subscript unicode characters
  return formula;
}

/**
 * AminoAcidHUD Component
 */
export function AminoAcidHUD({
  aminoAcid,
  position,
  visible,
}: AminoAcidHUDProps): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const hudRef = useRef<HTMLDivElement>(null);

  // Get amino acid info
  const info = aminoAcid ? getAminoAcidInfo(aminoAcid) : null;

  // Adjust position to keep HUD on screen
  useEffect(() => {
    if (!hudRef.current || !position || !visible) return;

    const hud = hudRef.current;
    const rect = hud.getBoundingClientRect();
    const viewportWidth = window.innerWidth;

    // Adjust horizontal position
    let left = position.x - rect.width / 2;
    if (left < 10) left = 10;
    if (left + rect.width > viewportWidth - 10) {
      left = viewportWidth - rect.width - 10;
    }

    // Position above the touch point by default
    let top = position.y - rect.height - 20;
    if (top < 10) {
      // If not enough room above, show below
      top = position.y + 30;
    }

    hud.style.left = `${left}px`;
    hud.style.top = `${top}px`;
  }, [position, visible]);

  if (!visible || !info || !position) return null;

  const classificationColor = getClassificationColor(info.classification);
  const rnaCodons = getRnaCodons(aminoAcid!);

  return (
    <div
      ref={hudRef}
      role="tooltip"
      aria-label={`Information about ${info.name}`}
      style={{
        position: 'fixed',
        zIndex: 9999,
        width: '320px',
        maxWidth: 'calc(100vw - 20px)',
        backgroundColor: colors.background,
        border: `2px solid ${classificationColor}`,
        borderRadius: '12px',
        boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
        overflow: 'hidden',
        animation: 'hudFadeIn 0.15s ease-out',
        touchAction: 'none',
        userSelect: 'none',
      }}
    >
      {/* Header with symbol and name */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '1rem',
          padding: '0.75rem 1rem',
          backgroundColor: classificationColor,
          color: '#000',
        }}
      >
        <div
          style={{
            width: '48px',
            height: '48px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '1.75rem',
            fontWeight: 'bold',
            backgroundColor: 'rgba(255, 255, 255, 0.9)',
            borderRadius: '8px',
          }}
        >
          {info.code1}
        </div>
        <div>
          <div style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>{info.name}</div>
          <div style={{ fontSize: '0.85rem', opacity: 0.8 }}>
            {info.code3} &middot; {getClassificationLabel(info.classification)}
          </div>
        </div>
      </div>

      {/* Main content */}
      <div style={{ padding: '0.75rem 1rem' }}>
        {/* Physical properties */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: '0.5rem',
            marginBottom: '0.75rem',
            fontSize: '0.8rem',
          }}
        >
          <div>
            <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>Molecular Weight</div>
            <div style={{ color: colors.text, fontWeight: 500 }}>
              {info.molecularWeight.toFixed(2)} g/mol
            </div>
          </div>
          <div>
            <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>Formula</div>
            <div style={{ color: colors.text, fontWeight: 500 }}>{formatFormula(info.formula)}</div>
          </div>
          <div>
            <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>Charge (pH 7)</div>
            <div
              style={{
                color:
                  info.chargeAtPh7 === 'positive'
                    ? '#3b82f6'
                    : info.chargeAtPh7 === 'negative'
                      ? '#ef4444'
                      : colors.text,
                fontWeight: 500,
              }}
            >
              {info.chargeAtPh7 === 'positive'
                ? '+ Positive'
                : info.chargeAtPh7 === 'negative'
                  ? '- Negative'
                  : 'Neutral'}
            </div>
          </div>
          <div>
            <div style={{ color: colors.textMuted, fontSize: '0.7rem' }}>Hydropathy</div>
            <div style={{ color: colors.text, fontWeight: 500 }}>
              {info.hydropathyIndex > 0 ? '+' : ''}
              {info.hydropathyIndex.toFixed(1)}
            </div>
          </div>
        </div>

        {/* Properties badges */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.35rem',
            marginBottom: '0.75rem',
          }}
        >
          {info.isEssential && (
            <span
              style={{
                padding: '0.2rem 0.5rem',
                backgroundColor: '#dc2626',
                color: '#fff',
                borderRadius: '4px',
                fontSize: '0.7rem',
                fontWeight: 600,
              }}
            >
              Essential
            </span>
          )}
          {info.isAromatic && (
            <span
              style={{
                padding: '0.2rem 0.5rem',
                backgroundColor: '#7c3aed',
                color: '#fff',
                borderRadius: '4px',
                fontSize: '0.7rem',
                fontWeight: 600,
              }}
            >
              Aromatic
            </span>
          )}
          {info.containsSulfur && (
            <span
              style={{
                padding: '0.2rem 0.5rem',
                backgroundColor: '#eab308',
                color: '#000',
                borderRadius: '4px',
                fontSize: '0.7rem',
                fontWeight: 600,
              }}
            >
              Sulfur
            </span>
          )}
        </div>

        {/* Essential explanation */}
        <div
          style={{
            padding: '0.5rem',
            backgroundColor: colors.backgroundAlt,
            borderRadius: '6px',
            marginBottom: '0.75rem',
            fontSize: '0.75rem',
            color: colors.textDim,
          }}
        >
          {info.isEssential ? (
            <>
              <strong style={{ color: colors.text }}>Essential amino acid</strong>
              <br />
              Must be obtained from diet; cannot be synthesized by humans.
            </>
          ) : (
            <>
              <strong style={{ color: colors.text }}>Non-essential amino acid</strong>
              <br />
              Can be synthesized by the body.
            </>
          )}
          {info.synthesisAtp > 0 && (
            <span style={{ display: 'block', marginTop: '0.25rem' }}>
              Biosynthesis cost: ~{info.synthesisAtp} ATP
            </span>
          )}
        </div>

        {/* Codons */}
        <div style={{ marginBottom: '0.5rem' }}>
          <div style={{ color: colors.textMuted, fontSize: '0.7rem', marginBottom: '0.25rem' }}>
            Encoded by ({info.codons.length} codon{info.codons.length !== 1 ? 's' : ''})
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
            {rnaCodons.map((codon) => (
              <span
                key={codon}
                style={{
                  padding: '0.25rem 0.5rem',
                  backgroundColor: colors.backgroundAlt,
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '4px',
                  fontSize: '0.8rem',
                  fontFamily: 'monospace',
                  color: colors.text,
                }}
              >
                {codon}
              </span>
            ))}
          </div>
        </div>

        {/* Special notes */}
        {info.specialNotes && (
          <div
            style={{
              padding: '0.5rem',
              backgroundColor: `${classificationColor}22`,
              borderLeft: `3px solid ${classificationColor}`,
              borderRadius: '0 4px 4px 0',
              fontSize: '0.75rem',
              color: colors.text,
              marginTop: '0.5rem',
            }}
          >
            {info.specialNotes}
          </div>
        )}

        {/* Side chain info */}
        <div
          style={{
            marginTop: '0.5rem',
            fontSize: '0.7rem',
            color: colors.textMuted,
          }}
        >
          Side chain: {info.sideChain}
        </div>
      </div>

      {/* Footer hint */}
      <div
        style={{
          padding: '0.5rem 1rem',
          borderTop: `1px solid ${colors.borderLight}`,
          fontSize: '0.65rem',
          color: colors.textMuted,
          textAlign: 'center',
        }}
      >
        Release to dismiss
      </div>

      {/* CSS animation */}
      <style>{`
        @keyframes hudFadeIn {
          from {
            opacity: 0;
            transform: translateY(8px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </div>
  );
}

export default AminoAcidHUD;
