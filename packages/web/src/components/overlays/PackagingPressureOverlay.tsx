import React, { useMemo, useState } from 'react';
import { useHotkey } from '../../hooks';
import { ActionIds } from '../../keyboard';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { usePhageStore } from '../../store';
import { packagingStateAt } from '@phage-explorer/core';
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
  const phage = usePhageStore((s) => s.currentPhage);
  const scrollPosition = usePhageStore((s) => s.scrollPosition);
  const viewMode = usePhageStore((s) => s.viewMode);

  // Hotkey: Shift+V (matches TUI)
  useHotkey(
    ActionIds.OverlayPackagingPressure,
    () => toggle('pressure'),
    { modes: ['NORMAL'] }
  );

  /**
   * Ionic strength of the buffer, in mol/L. 0.1 M is the usual in-vitro
   * condition and roughly matches intracellular monovalent salt.
   *
   * Exposed as a control because it is the input the model is most sensitive to
   * -- screening the phosphate backbone is what lets DNA pack at all -- and a
   * physics model whose one interesting knob is hidden is a curve with extra
   * steps.
   */
  const [ionicStrengthM, setIonicStrengthM] = useState(0.1);

  const metrics = useMemo(() => {
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

    // Was `force = 5 + 50*phi^3` and `pressure = min(60, 5 + 55*phi)`: closed
    // forms in which nothing but genome length and cursor position appeared,
    // while the README described a bending-energy and Debye-screening model
    // that existed nowhere in the code. It now does, and the capsid radius
    // comes from the phage's morphology, so two phages with the same genome
    // length in different heads give different answers.
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

  if (!isOpen('pressure')) {
    return null;
  }

  const genomeLength = phage?.genomeLength ?? 0;
  const fillPercent = (metrics.fillFraction * 100).toFixed(1);
  const pressureFraction = metrics.pressureAtm / 60;

  return (
    <Overlay
      id="pressure"
      title="PACKAGING PRESSURE"
      hotkey="Shift+V"
      size="md"
    >
      <OverlayStack>
        <OverlayDescription title="Inverse-spool packaging model">
          Bending energy ξ<sub>p</sub>kT/2R² plus screened interstrand repulsion
          F₀·e<sup>−d/λ<sub>D</sub></sup>, with λ<sub>D</sub> = 0.304/√I nm. Force is
          dE/dL; pressure is that force over the portal channel. Capsid radius comes
          from morphology ({metrics.capsidRadiusNm} nm here). ATP at the measured 2 bp
          per hydrolysis. One fitted constant, F₀, anchored to the ~57 pN measured for
          λ at full packing.
        </OverlayDescription>

        {genomeLength > 0 ? (
          <>
            <OverlayStatGrid>
              <OverlayStatCard
                label="Position"
                value={`${metrics.positionBp.toLocaleString()} / ${genomeLength.toLocaleString()} bp`}
              />
              <OverlayStatCard label="Fill" value={`${fillPercent}%`} />
              <OverlayStatCard label="Force" value={`${metrics.forcePn.toFixed(1)} pN`} />
              <OverlayStatCard
                label="Pressure"
                value={
                  <span
                    style={{
                      color: pressureFraction > 0.8 ? 'var(--color-error)' : 'var(--color-text)',
                    }}
                  >
                    {metrics.pressureAtm.toFixed(1)} atm
                  </span>
                }
              />
              <OverlayStatCard label="ATP consumed" value={metrics.atpCount.toLocaleString()} />
              {/* The two quantities the model computes on the way to the force.
                  Both are independently checkable: measured interaxial spacing
                  in tightly packed phage heads is 2.5-2.8 nm. */}
              <OverlayStatCard
                label="DNA spacing"
                value={
                  Number.isFinite(metrics.spacingNm) ? `${metrics.spacingNm.toFixed(2)} nm` : '\u2014'
                }
              />
              <OverlayStatCard label="Debye length" value={`${metrics.debyeNm.toFixed(2)} nm`} />
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
                  {progressBar(metrics.fillFraction, 'var(--color-success)')}
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
