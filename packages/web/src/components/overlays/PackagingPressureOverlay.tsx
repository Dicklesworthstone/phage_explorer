import React, { useMemo, useState } from 'react';
import { useHotkey } from '../../hooks';
import { useTheme } from '../../hooks/useTheme';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { usePhageStore } from '../../store';
import {
  packagingStateAt,
  analyzeCapsidPackagingEnergetics,
  CANONICAL_CAPSIDS,
  CANONICAL_MOTORS,
  type CapsidGeometry,
  type MotorProperties,
} from '@phage-explorer/core';
import {
  OverlayDescription,
  OverlayEmptyState,
  OverlaySection,
  OverlaySectionHeader,
  OverlayStack,
  OverlayStatCard,
  OverlayStatGrid,
} from './primitives';

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function progressBar(fraction: number, color: string): React.ReactElement {
  const safeFraction = clamp01(fraction);
  return (
    <div
      style={{
        width: '100%',
        height: '10px',
        backgroundColor: 'var(--color-background-alt)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
        border: 'var(--overlay-border)',
      }}
    >
      <div
        style={{
          width: `${(safeFraction * 100).toFixed(1)}%`,
          height: '100%',
          background: color,
          transition: 'width var(--duration-fast) var(--ease-out)',
        }}
      />
    </div>
  );
}

export function PackagingPressureOverlay(): React.ReactElement | null {
  const { isOpen, toggle } = useOverlay();
  const { theme } = useTheme();
  const colors = theme.colors;
  const phage = usePhageStore((s) => s.currentPhage);
  const scrollPosition = usePhageStore((s) => s.scrollPosition);
  const viewMode = usePhageStore((s) => s.viewMode);

  // View mode tab: Cursor State tracking vs Full Biophysical Simulator
  const [activeTab, setActiveTab] = useState<'cursor_state' | 'energetics_simulator'>('cursor_state');

  // Simulator buffer and model parameters
  const [simIonicM, setSimIonicM] = useState(0.15);
  const [simMgMm, setSimMgMm] = useState(10.0);
  const [simOsmoticAtm, setSimOsmoticAtm] = useState(3.5);
  const [selectedCapsidKey, setSelectedCapsidKey] = useState<string>('auto');
  const [selectedMotorKey, setSelectedMotorKey] = useState<string>('auto');

  // Hotkey: Shift+V (matches TUI)
  useHotkey(
    ActionIds.OverlayPackagingPressure,
    () => toggle('pressure'),
    { modes: ['NORMAL'] }
  );

  /**
   * Cursor state ionic strength
   */
  const [ionicStrengthM, setIonicStrengthM] = useState(0.1);

  const cursorMetrics = useMemo(() => {
    const genomeLength = phage?.genomeLength ?? 0;
    if (!genomeLength) {
      return {
        fillFraction: 0,
        positionBp: 0,
        forcePn: 0,
        pressureAtm: 0,
        atpCount: 0,
        spacingNm: 0,
        debyeNm: 0,
        capsidRadiusNm: 0,
      };
    }

    const scrollBp = viewMode === 'aa' ? scrollPosition * 3 : scrollPosition;
    const clampedBp = Math.max(0, Math.min(genomeLength, scrollBp));
    const state = packagingStateAt(clampedBp, genomeLength, phage?.morphology, ionicStrengthM);

    return {
      fillFraction: clamp01(clampedBp / genomeLength),
      positionBp: clampedBp,
      forcePn: state.forcePn,
      pressureAtm: state.pressureAtm,
      atpCount: state.atpCount,
      spacingNm: state.spacingNm,
      debyeNm: state.debyeNm,
      capsidRadiusNm: state.capsidRadiusNm,
    };
  }, [phage?.genomeLength, phage?.morphology, scrollPosition, viewMode, ionicStrengthM]);

  // Full biophysical thermodynamics & ejection simulator analysis
  const simulation = useMemo(() => {
    if (!phage) return null;

    let capsidOverride: CapsidGeometry | undefined;
    if (selectedCapsidKey !== 'auto' && CANONICAL_CAPSIDS[selectedCapsidKey]) {
      capsidOverride = CANONICAL_CAPSIDS[selectedCapsidKey];
    }

    let motorOverride: MotorProperties | undefined;
    if (selectedMotorKey !== 'auto' && CANONICAL_MOTORS[selectedMotorKey]) {
      motorOverride = CANONICAL_MOTORS[selectedMotorKey];
    }

    return analyzeCapsidPackagingEnergetics(phage, {
      ionicStrengthM: simIonicM,
      magnesiumMm: simMgMm,
      targetOsmoticAtm: simOsmoticAtm,
      capsidOverride,
      motorOverride,
    });
  }, [phage, simIonicM, simMgMm, simOsmoticAtm, selectedCapsidKey, selectedMotorKey]);

  if (!isOpen('pressure')) {
    return null;
  }

  const genomeLength = phage?.genomeLength ?? 0;
  const fillPercent = (cursorMetrics.fillFraction * 100).toFixed(1);
  const pressureFraction = cursorMetrics.pressureAtm / 60;

  return (
    <Overlay
      id="pressure"
      title="PACKAGING & EJECTION ENERGETICS"
      hotkey="Shift+V"
      size="lg"
    >
      <OverlayStack>
        {/* View Mode Navigation Tabs */}
        <div style={{ display: 'flex', gap: '0.5rem', borderBottom: `1px solid ${colors.borderLight}`, paddingBottom: '0.5rem' }}>
          <button
            type="button"
            onClick={() => setActiveTab('cursor_state')}
            style={{
              padding: '0.4rem 0.8rem',
              borderRadius: '4px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.85rem',
              backgroundColor: activeTab === 'cursor_state' ? (colors.primary ?? '#3b82f6') : colors.backgroundAlt,
              color: activeTab === 'cursor_state' ? '#ffffff' : colors.textMuted,
            }}
          >
            Cursor State Tracking
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('energetics_simulator')}
            style={{
              padding: '0.4rem 0.8rem',
              borderRadius: '4px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.85rem',
              backgroundColor: activeTab === 'energetics_simulator' ? (colors.primary ?? '#3b82f6') : colors.backgroundAlt,
              color: activeTab === 'energetics_simulator' ? '#ffffff' : colors.textMuted,
            }}
          >
            Thermodynamic Energetics & Ejection Simulator
          </button>
        </div>

        {genomeLength > 0 ? (
          activeTab === 'cursor_state' ? (
            <>
              <OverlayDescription title="Inverse-spool packaging model">
                Bending energy ξ<sub>p</sub>kT/2R² plus screened interstrand repulsion
                F₀·e<sup>−d/λ<sub>D</sub></sup>, with λ<sub>D</sub> = 0.304/√I nm. Force is
                dE/dL; pressure is that force over the portal channel. Capsid radius comes
                from morphology ({cursorMetrics.capsidRadiusNm} nm here). ATP at the measured 2 bp
                per hydrolysis. One fitted constant, F₀, anchored to the ~57 pN measured for
                λ at full packing.
              </OverlayDescription>

              <OverlayStatGrid>
                <OverlayStatCard
                  label="Position"
                  value={`${cursorMetrics.positionBp.toLocaleString()} / ${genomeLength.toLocaleString()} bp`}
                />
                <OverlayStatCard label="Fill" value={`${fillPercent}%`} />
                <OverlayStatCard label="Force" value={`${cursorMetrics.forcePn.toFixed(1)} pN`} />
                <OverlayStatCard
                  label="Pressure"
                  value={
                    <span
                      style={{
                        color: pressureFraction > 0.8 ? 'var(--color-error)' : 'var(--color-text)',
                      }}
                    >
                      {cursorMetrics.pressureAtm.toFixed(1)} atm
                    </span>
                  }
                />
                <OverlayStatCard label="ATP consumed" value={cursorMetrics.atpCount.toLocaleString()} />
                <OverlayStatCard
                  label="DNA spacing"
                  value={
                    Number.isFinite(cursorMetrics.spacingNm) ? `${cursorMetrics.spacingNm.toFixed(2)} nm` : '\u2014'
                  }
                />
                <OverlayStatCard label="Debye length" value={`${cursorMetrics.debyeNm.toFixed(2)} nm`} />
              </OverlayStatGrid>

              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.75rem',
                  fontSize: '0.85rem',
                  color: 'var(--color-text-muted)',
                }}
              >
                <span style={{ minWidth: '9rem' }}>Ionic strength</span>
                <input
                  type="range"
                  min={0.01}
                  max={0.5}
                  step={0.01}
                  value={ionicStrengthM}
                  onChange={e => setIonicStrengthM(Number(e.target.value))}
                  style={{ flex: 1 }}
                  aria-label="Buffer ionic strength in mol per litre"
                />
                <span style={{ fontFamily: 'monospace', minWidth: '5rem' }}>
                  {ionicStrengthM.toFixed(2)} M
                </span>
              </label>

              <OverlaySection
                header={<OverlaySectionHeader title="Trajectory" description={`${fillPercent}% full`} />}
              >
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 'var(--chrome-gap)',
                    padding: 'var(--chrome-padding-y) var(--chrome-padding-x)',
                  }}
                >
                  <div>
                    <div
                      style={{
                        color: 'var(--color-text-muted)',
                        marginBottom: 'var(--chrome-gap-compact)',
                        fontSize: 'var(--text-xs)',
                      }}
                    >
                      Fill fraction
                    </div>
                    {progressBar(cursorMetrics.fillFraction, 'var(--color-success)')}
                  </div>
                  <div>
                    <div
                      style={{
                        color: 'var(--color-text-muted)',
                        marginBottom: 'var(--chrome-gap-compact)',
                        fontSize: 'var(--text-xs)',
                      }}
                    >
                      Pressure (warn above 50 atm)
                    </div>
                    {progressBar(
                      pressureFraction,
                      pressureFraction > 0.83 ? 'var(--color-error)' : 'var(--color-accent)'
                    )}
                  </div>
                </div>
              </OverlaySection>
            </>
          ) : (
            /* Full Biophysical Energetics & Ejection Simulator View */
            simulation && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {/* Viability and Rupture Risk Alert Banner */}
                <div
                  style={{
                    padding: '0.85rem 1rem',
                    borderRadius: '6px',
                    border: `1px solid ${simulation.isViable ? colors.success : colors.error}`,
                    backgroundColor: `${simulation.isViable ? colors.success : colors.error}15`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    flexWrap: 'wrap',
                    gap: '0.75rem',
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 700, fontSize: '0.95rem', color: simulation.isViable ? colors.success : colors.error }}>
                      {simulation.isViable ? 'CAPSID PACKAGING VIABLE & STABLE' : 'PACKAGING / RUPTURE RISK DETECTED'}
                    </div>
                    <div style={{ fontSize: '0.82rem', color: colors.textMuted, marginTop: '2px' }}>
                      {simulation.viabilitySummary}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '0.75rem', color: colors.textDim }}>Stability Score</div>
                      <div style={{ fontWeight: 700, fontSize: '1.1rem', color: simulation.stabilityScore >= 70 ? colors.success : colors.warning }}>
                        {simulation.stabilityScore}/100
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '0.75rem', color: colors.textDim }}>Pressure / Burst Limit</div>
                      <div style={{ fontWeight: 700, fontSize: '1.1rem', color: simulation.internalPressureAtm > simulation.burstPressureThresholdAtm ? colors.error : colors.text }}>
                        {simulation.internalPressureAtm.toFixed(1)} / {simulation.burstPressureThresholdAtm} atm
                      </div>
                    </div>
                  </div>
                </div>

                {/* Simulation Parameter Controls */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                    gap: '0.75rem',
                    padding: '0.75rem',
                    borderRadius: '6px',
                    backgroundColor: colors.backgroundAlt,
                    border: `1px solid ${colors.borderLight}`,
                  }}
                >
                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.8rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.textMuted }}>
                      <span>Monovalent Salt [Na+/K+]</span>
                      <span style={{ fontFamily: 'monospace', color: colors.text }}>{simIonicM.toFixed(2)} M</span>
                    </div>
                    <input
                      type="range"
                      min={0.01}
                      max={0.50}
                      step={0.01}
                      value={simIonicM}
                      onChange={(e) => setSimIonicM(Number(e.target.value))}
                      aria-label="Monovalent salt concentration in mol/L"
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.8rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.textMuted }}>
                      <span>Divalent Magnesium [Mg²⁺]</span>
                      <span style={{ fontFamily: 'monospace', color: colors.text }}>{simMgMm.toFixed(1)} mM</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={30}
                      step={1}
                      value={simMgMm}
                      onChange={(e) => setSimMgMm(Number(e.target.value))}
                      aria-label="Divalent magnesium concentration in mmol/L"
                    />
                  </label>

                  <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.8rem' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', color: colors.textMuted }}>
                      <span>Host Osmotic Counter-Pressure</span>
                      <span style={{ fontFamily: 'monospace', color: colors.text }}>{simOsmoticAtm.toFixed(1)} atm</span>
                    </div>
                    <input
                      type="range"
                      min={1.0}
                      max={10.0}
                      step={0.5}
                      value={simOsmoticAtm}
                      onChange={(e) => setSimOsmoticAtm(Number(e.target.value))}
                      aria-label="Cytoplasmic counter osmotic pressure in atmospheres"
                    />
                  </label>

                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.8rem' }}>
                      <span style={{ color: colors.textMuted }}>Capsid Shell</span>
                      <select
                        value={selectedCapsidKey}
                        onChange={(e) => setSelectedCapsidKey(e.target.value)}
                        style={{
                          padding: '0.35rem',
                          borderRadius: '4px',
                          border: `1px solid ${colors.borderLight}`,
                          backgroundColor: colors.background,
                          color: colors.text,
                          fontSize: '0.8rem',
                        }}
                      >
                        <option value="auto">Auto-scaled ({simulation.capsid.name})</option>
                        {Object.entries(CANONICAL_CAPSIDS).map(([k, c]) => (
                          <option key={k} value={k}>{c.name}</option>
                        ))}
                      </select>
                    </label>

                    <label style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '0.8rem' }}>
                      <span style={{ color: colors.textMuted }}>Packaging Motor</span>
                      <select
                        value={selectedMotorKey}
                        onChange={(e) => setSelectedMotorKey(e.target.value)}
                        style={{
                          padding: '0.35rem',
                          borderRadius: '4px',
                          border: `1px solid ${colors.borderLight}`,
                          backgroundColor: colors.background,
                          color: colors.text,
                          fontSize: '0.8rem',
                        }}
                      >
                        <option value="auto">Auto ({simulation.motor.name})</option>
                        {Object.entries(CANONICAL_MOTORS).map(([k, m]) => (
                          <option key={k} value={k}>{m.name} ({m.stallForce} pN)</option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>

                {/* Key Biophysical Quantities Stat Grid */}
                <OverlayStatGrid>
                  <OverlayStatCard
                    label="Fill Fraction"
                    value={`${(simulation.fillFraction * 100).toFixed(1)}%`}
                  />
                  <OverlayStatCard
                    label="Internal Pressure"
                    value={`${simulation.internalPressureAtm.toFixed(1)} atm`}
                  />
                  <OverlayStatCard
                    label="Packing Density"
                    value={`${simulation.dnaPackingDensityMgMl} mg/mL`}
                  />
                  <OverlayStatCard
                    label="DNA Interhelix (dH)"
                    value={`${simulation.interhelixDistanceNm.toFixed(2)} nm`}
                  />
                  <OverlayStatCard
                    label="Decay Length (λD)"
                    value={`${simulation.debyeLengthNm.toFixed(2)} nm`}
                  />
                  <OverlayStatCard
                    label="Total Motor Work"
                    value={`${simulation.totalMotorWorkKbt.toLocaleString()} kBT`}
                  />
                  <OverlayStatCard
                    label="ATP Required"
                    value={simulation.atpRequired.toLocaleString()}
                  />
                  <OverlayStatCard
                    label="Packaging Time"
                    value={`${simulation.packagingTimeSec.toFixed(1)} s`}
                  />
                  <OverlayStatCard
                    label="Initial Ejection Vel"
                    value={`${simulation.ejectionInitialVelocityBpPerSec.toLocaleString()} bp/s`}
                  />
                  <OverlayStatCard
                    label="Ejection Duration"
                    value={`${simulation.ejectionDurationMs} ms`}
                  />
                </OverlayStatGrid>

                {/* Competing Thermodynamic Energy Terms Breakdown */}
                <OverlaySection
                  header={
                    <OverlaySectionHeader
                      title="Three Competing Thermodynamic Energy Terms"
                      description={`Total ΔG = ${simulation.totalFreeEnergyKbt.toLocaleString()} k_BT`}
                    />
                  }
                >
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '0.5rem 0' }}>
                    {/* Proportional energy bar */}
                    {(() => {
                      const sum = Math.max(1, simulation.bendingEnergyKbt + simulation.confinementEntropyKbt + simulation.electrostaticRepulsionKbt);
                      const pBend = (simulation.bendingEnergyKbt / sum) * 100;
                      const pConf = (simulation.confinementEntropyKbt / sum) * 100;
                      const pElec = (simulation.electrostaticRepulsionKbt / sum) * 100;

                      return (
                        <div style={{ width: '100%', height: '14px', borderRadius: '4px', overflow: 'hidden', display: 'flex', border: `1px solid ${colors.borderLight}` }}>
                          <div key="bend" style={{ width: `${pBend}%`, backgroundColor: '#3b82f6' }} title={`Bending: ${pBend.toFixed(1)}%`} />
                          <div key="conf" style={{ width: `${pConf}%`, backgroundColor: '#8b5cf6' }} title={`Confinement: ${pConf.toFixed(1)}%`} />
                          <div key="elec" style={{ width: `${pElec}%`, backgroundColor: '#f59e0b' }} title={`Electrostatic: ${pElec.toFixed(1)}%`} />
                        </div>
                      );
                    })()}

                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0.75rem' }}>
                      <div style={{ padding: '0.6rem', borderRadius: '4px', backgroundColor: colors.backgroundAlt, borderLeft: '3px solid #3b82f6' }}>
                        <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>Bending Energy (ΔG_bend)</div>
                        <div style={{ fontWeight: 700, fontSize: '1rem', color: '#3b82f6' }}>{simulation.bendingEnergyKbt.toLocaleString()} k_BT</div>
                        <div style={{ fontSize: '0.75rem', color: colors.textDim, marginTop: '2px' }}>
                          Concentric spooling: Lp·L / 2R²eff
                        </div>
                      </div>

                      <div style={{ padding: '0.6rem', borderRadius: '4px', backgroundColor: colors.backgroundAlt, borderLeft: '3px solid #8b5cf6' }}>
                        <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>Confinement Entropy (ΔG_conf)</div>
                        <div style={{ fontWeight: 700, fontSize: '1rem', color: '#8b5cf6' }}>{simulation.confinementEntropyKbt.toLocaleString()} k_BT</div>
                        <div style={{ fontSize: '0.75rem', color: colors.textDim, marginTop: '2px' }}>
                          Odijk regime: L/λd (1 + 1.8·φ^1.5)
                        </div>
                      </div>

                      <div style={{ padding: '0.6rem', borderRadius: '4px', backgroundColor: colors.backgroundAlt, borderLeft: '3px solid #f59e0b' }}>
                        <div style={{ fontSize: '0.75rem', color: colors.textMuted }}>Electrostatic Repulsion (ΔG_elec)</div>
                        <div style={{ fontWeight: 700, fontSize: '1rem', color: '#f59e0b' }}>{simulation.electrostaticRepulsionKbt.toLocaleString()} k_BT</div>
                        <div style={{ fontSize: '0.75rem', color: colors.textDim, marginTop: '2px' }}>
                          Debye-Hückel: F₀·e^(−dH/λD)
                        </div>
                      </div>
                    </div>
                  </div>
                </OverlaySection>

                {/* Force-Extension & Packaging Progression */}
                <OverlaySection
                  header={
                    <OverlaySectionHeader
                      title="Packaging Force & Pressure Progression"
                      description={`Motor stall threshold: ${simulation.motor.stallForce} pN`}
                    />
                  }
                >
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${colors.borderLight}`, color: colors.textMuted }}>
                          <th style={{ padding: '0.4rem' }}>Fill %</th>
                          <th style={{ padding: '0.4rem' }}>Packed bp</th>
                          <th style={{ padding: '0.4rem' }}>Force (pN)</th>
                          <th style={{ padding: '0.4rem' }}>Pressure (atm)</th>
                          <th style={{ padding: '0.4rem' }}>Free Energy (k_BT)</th>
                          <th style={{ padding: '0.4rem' }}>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {simulation.forceCurve.filter((_, idx) => idx % 2 === 0).map((step) => {
                          const isStall = step.forcePn >= simulation.motor.stallForce;
                          return (
                            <tr key={step.fillFraction} style={{ borderBottom: `1px solid ${colors.borderLight}33` }}>
                              <td style={{ padding: '0.4rem', fontFamily: 'monospace' }}>{(step.fillFraction * 100).toFixed(0)}%</td>
                              <td style={{ padding: '0.4rem', fontFamily: 'monospace' }}>{step.packedBp.toLocaleString()}</td>
                              <td style={{ padding: '0.4rem', fontFamily: 'monospace', fontWeight: 600, color: isStall ? colors.error : colors.text }}>
                                {step.forcePn.toFixed(1)} pN
                              </td>
                              <td style={{ padding: '0.4rem', fontFamily: 'monospace' }}>{step.pressureAtm.toFixed(1)} atm</td>
                              <td style={{ padding: '0.4rem', fontFamily: 'monospace' }}>{step.totalEnergyKbt.toLocaleString()}</td>
                              <td style={{ padding: '0.4rem' }}>
                                <span style={{
                                  fontSize: '0.7rem',
                                  padding: '1px 6px',
                                  borderRadius: '3px',
                                  backgroundColor: isStall ? `${colors.error}20` : `${colors.success}20`,
                                  color: isStall ? colors.error : colors.success,
                                }}>
                                  {isStall ? 'Motor Stall' : 'Packaging'}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </OverlaySection>

                {/* Time-Resolved Ejection Dynamics Simulation */}
                <OverlaySection
                  header={
                    <OverlaySectionHeader
                      title="Time-Resolved Ejection Dynamics into Host Cytoplasm"
                      description={`Counter-osmotic cellular resistance: ${simOsmoticAtm.toFixed(1)} atm`}
                    />
                  }
                >
                  <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${colors.borderLight}`, color: colors.textMuted }}>
                          <th style={{ padding: '0.4rem' }}>Time (ms)</th>
                          <th style={{ padding: '0.4rem' }}>Ejected %</th>
                          <th style={{ padding: '0.4rem' }}>Bp Ejected</th>
                          <th style={{ padding: '0.4rem' }}>Velocity (bp/s)</th>
                          <th style={{ padding: '0.4rem' }}>Internal P (atm)</th>
                          <th style={{ padding: '0.4rem' }}>Net Driving P (atm)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {simulation.ejectionTrajectory.slice(0, 10).map((step) => (
                          <tr key={step.timeMs} style={{ borderBottom: `1px solid ${colors.borderLight}33` }}>
                            <td style={{ padding: '0.4rem', fontFamily: 'monospace' }}>{step.timeMs} ms</td>
                            <td style={{ padding: '0.4rem', fontFamily: 'monospace' }}>{(step.fractionEjected * 100).toFixed(1)}%</td>
                            <td style={{ padding: '0.4rem', fontFamily: 'monospace' }}>{step.bpEjected.toLocaleString()}</td>
                            <td style={{ padding: '0.4rem', fontFamily: 'monospace', color: colors.primary ?? '#3b82f6' }}>
                              {step.velocityBpPerSec.toLocaleString()}
                            </td>
                            <td style={{ padding: '0.4rem', fontFamily: 'monospace' }}>{step.internalPressureAtm.toFixed(1)}</td>
                            <td style={{ padding: '0.4rem', fontFamily: 'monospace', fontWeight: 600 }}>
                              {step.netDrivingPressureAtm.toFixed(1)} atm
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </OverlaySection>
              </div>
            )
          )
        ) : (
          <OverlayEmptyState
            message="No phage loaded."
            hint="Load a phage genome to visualize packaging pressure along the sequence."
          />
        )}
      </OverlayStack>
    </Overlay>
  );
}

export default PackagingPressureOverlay;
