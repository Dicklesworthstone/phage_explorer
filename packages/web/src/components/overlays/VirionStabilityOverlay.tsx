import React, { useEffect, useMemo, useState } from 'react';
import { predictVirionStabilityFromPhage, AMINO_ACIDS, type PhageFull } from '@phage-explorer/core';
import { useTheme } from '../../hooks/useTheme';
import { usePhageStore } from '../../store';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const clamp01 = (v: number) => clamp(v, 0, 1);

function Gauge({ value, color }: { value: number; color: string }): React.ReactElement {
  const pct = clamp01(value) * 100;
  return (
    <div
      aria-label={`Integrity ${pct.toFixed(1)}%`}
      style={{
        width: '100%',
        height: '14px',
        background: 'rgba(255,255,255,0.06)',
        borderRadius: '999px',
        overflow: 'hidden',
        border: '1px solid rgba(255,255,255,0.12)',
      }}
    >
      <div
        style={{
          width: `${pct.toFixed(1)}%`,
          height: '100%',
          background: color,
          transition: 'width 120ms ease-out',
        }}
      />
    </div>
  );
}

function Pill({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div
      style={{
        display: 'inline-flex',
        gap: '0.4rem',
        alignItems: 'center',
        padding: '0.35rem 0.6rem',
        borderRadius: '999px',
        border: '1px solid rgba(255,255,255,0.1)',
        background: 'rgba(255,255,255,0.04)',
        fontSize: '0.85rem',
      }}
    >
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ fontWeight: 600 }}>{value}</span>
    </div>
  );
}

function phageSummary(phage: PhageFull | null): string {
  if (!phage) return 'No phage selected';
  const parts = [
    phage.name,
    phage.genomeLength ? `${phage.genomeLength.toLocaleString()} bp` : null,
    phage.gcContent != null ? `${(phage.gcContent * 100).toFixed(1)}% GC` : null,
    phage.morphology ?? null,
  ].filter(Boolean);
  return parts.join(' · ');
}

export function VirionStabilityOverlay(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const phage = usePhageStore((s) => s.currentPhage);

  const [temperatureC, setTemperatureC] = useState(4);
  const [saltMilliMolar, setSaltMilliMolar] = useState(100);

  // Hotkey: Alt+V (avoid conflict with packaging pressure 'v')
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'v' || e.key === 'V') && e.altKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        toggle('stability');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggle]);

  const estimate = useMemo(
    () => predictVirionStabilityFromPhage(phage, { temperatureC, saltMilliMolar }),
    [phage, temperatureC, saltMilliMolar]
  );

  const propertyStats = useMemo(() => {
    const aaCounts = phage?.codonUsage?.aaCounts ?? {};
    const total = Object.values(aaCounts).reduce((acc, v) => acc + v, 0);
    if (total === 0) {
      return {
        hydrophobicPct: 0,
        cysteineCount: 0,
        aromaticPct: 0,
      };
    }

    let hydrophobic = 0;
    let aromatic = 0;
    for (const [aa, count] of Object.entries(aaCounts)) {
      const info = AMINO_ACIDS[aa as keyof typeof AMINO_ACIDS];
      if (!info) continue;
      if (info.property === 'hydrophobic') hydrophobic += count;
      if (['F', 'W', 'Y'].includes(aa)) aromatic += count;
    }

    return {
      hydrophobicPct: (hydrophobic / total) * 100,
      cysteineCount: aaCounts['C'] ?? 0,
      aromaticPct: (aromatic / total) * 100,
    };
  }, [phage?.codonUsage?.aaCounts]);

  if (!isOpen('stability')) {
    return null;
  }

  const statusColor =
    estimate.status === 'robust'
      ? colors.success
      : estimate.status === 'moderate'
      ? colors.warning
      : colors.error;

  const summary = phageSummary(phage);

  return (
    <Overlay
      id="stability"
      title="VIRION STABILITY"
      icon="🛡️"
      hotkey="Alt+V"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'center' }}>
          <Pill label="Phage" value={summary || '—'} />
          <Pill label="Environment" value={`${temperatureC.toFixed(0)}°C · ${saltMilliMolar.toFixed(0)} mM`} />
          <Pill label="PDB models" value={(phage?.pdbIds?.length ?? 0).toString()} />
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: '1rem',
          }}
        >
          <div
            style={{
              padding: '1rem',
              background: colors.backgroundAlt,
              borderRadius: '8px',
              border: `1px solid ${colors.borderLight}`,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ color: colors.textMuted, fontSize: '0.9rem' }}>Integrity</div>
              <div style={{ color: statusColor, fontWeight: 700 }}>
                {(estimate.integrity * 100).toFixed(1)}% ({estimate.status})
              </div>
            </div>
            <Gauge value={estimate.integrity} color={statusColor} />
            <div style={{ color: colors.textMuted, fontSize: '0.9rem', lineHeight: 1.4 }}>
              Base index {(estimate.baseIndex * 100).toFixed(0)}% · Packaging penalty{' '}
              {(estimate.packagingPenalty * 100).toFixed(0)}% · Temp factor{' '}
              {(estimate.temperatureFactor * 100).toFixed(0)}% · Salt factor{' '}
              {(estimate.saltFactor * 100).toFixed(0)}%
            </div>
          </div>

          <div
            style={{
              padding: '1rem',
              background: colors.backgroundAlt,
              borderRadius: '8px',
              border: `1px solid ${colors.borderLight}`,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.75rem',
            }}
          >
            <div style={{ color: colors.text, fontWeight: 700 }}>Environment controls</div>
            <label style={{ color: colors.textMuted, fontSize: '0.9rem' }}>
              Temperature (°C)
              <input
                type="range"
                min={-10}
                max={80}
                step={1}
                value={temperatureC}
                onChange={(e) => setTemperatureC(Number(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ color: colors.text, fontFamily: 'monospace' }}>{temperatureC.toFixed(0)} °C</div>
            </label>
            <label style={{ color: colors.textMuted, fontSize: '0.9rem' }}>
              Salt (mM)
              <input
                type="range"
                min={0}
                max={500}
                step={5}
                value={saltMilliMolar}
                onChange={(e) => setSaltMilliMolar(Number(e.target.value))}
                style={{ width: '100%' }}
              />
              <div style={{ color: colors.text, fontFamily: 'monospace' }}>{saltMilliMolar.toFixed(0)} mM</div>
            </label>
            <div style={{ color: colors.textMuted, fontSize: '0.9rem', lineHeight: 1.4 }}>
              Recommended storage: {estimate.recommendedStorage.temperatureC}°C,{' '}
              {estimate.recommendedStorage.saltMilliMolar} mM. Melting onset ~{estimate.meltingTempC.toFixed(1)}°C.
            </div>
          </div>

          <div
            style={{
              padding: '1rem',
              background: colors.backgroundAlt,
              borderRadius: '8px',
              border: `1px solid ${colors.borderLight}`,
              display: 'flex',
              flexDirection: 'column',
              gap: '0.6rem',
            }}
          >
            <div style={{ color: colors.text, fontWeight: 700 }}>Capsid chemistry snapshot</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.5rem' }}>
              <div style={{ color: colors.textMuted }}>Hydrophobic content</div>
              <div style={{ color: colors.text, fontFamily: 'monospace' }}>
                {propertyStats.hydrophobicPct.toFixed(1)}%
              </div>
              <div style={{ color: colors.textMuted }}>Aromatic content</div>
              <div style={{ color: colors.text, fontFamily: 'monospace' }}>
                {propertyStats.aromaticPct.toFixed(1)}%
              </div>
              <div style={{ color: colors.textMuted }}>Cysteines</div>
              <div style={{ color: colors.text, fontFamily: 'monospace' }}>
                {propertyStats.cysteineCount} (potential {Math.floor(propertyStats.cysteineCount / 2)} disulfides)
              </div>
            </div>
            <div style={{ color: colors.textMuted, fontSize: '0.85rem', lineHeight: 1.4 }}>
              Based on codon usage composition; refine with protein models when available.
            </div>
          </div>
        </div>

        {(estimate.warnings.length > 0 || estimate.notes.length > 0) && (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: '1rem',
            }}
          >
            {estimate.warnings.length > 0 && (
              <div
                style={{
                  padding: '0.9rem',
                  background: 'rgba(255,180,0,0.06)',
                  border: `1px solid ${colors.warning}`,
                  borderRadius: '6px',
                  color: colors.warning,
                  lineHeight: 1.5,
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: '0.35rem' }}>Warnings</div>
                {estimate.warnings.map((w, idx) => (
                  <div key={idx}>• {w}</div>
                ))}
              </div>
            )}
            {estimate.notes.length > 0 && (
              <div
                style={{
                  padding: '0.9rem',
                  background: colors.backgroundAlt,
                  border: `1px solid ${colors.borderLight}`,
                  borderRadius: '6px',
                  color: colors.textMuted,
                  lineHeight: 1.5,
                }}
              >
                <div style={{ fontWeight: 700, color: colors.text, marginBottom: '0.35rem' }}>Notes</div>
                {estimate.notes.map((w, idx) => (
                  <div key={idx}>• {w}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </Overlay>
  );
}

export default VirionStabilityOverlay;

