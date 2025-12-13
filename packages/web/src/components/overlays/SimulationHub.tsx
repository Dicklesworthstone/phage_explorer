/**
 * SimulationHub - Modal Launcher
 *
 * A modal for launching and configuring simulations.
 * Matches the TUI SimulationMenuOverlay pattern.
 * Includes SVG preview thumbnails for each simulation type.
 */

import React, { useState, useEffect, useMemo } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { SIMULATION_METADATA } from '@phage-explorer/core';

interface SimulationDef {
  id: string;
  label: string;
  description: string;
  icon: string;
  shortcut: string;
  category: string;
  duration?: string;
  complexity?: 'simple' | 'moderate' | 'complex';
  priority: number;
}

/**
 * SVG Preview Thumbnails for simulations
 * Each returns a small SVG depicting the simulation type
 */
interface ThumbnailProps {
  accentColor: string;
  mutedColor: string;
}

function LyticCycleThumbnail({ accentColor, mutedColor }: ThumbnailProps): React.ReactElement {
  return (
    <svg width="48" height="32" viewBox="0 0 48 32">
      <circle cx="16" cy="16" r="10" fill="none" stroke={mutedColor} strokeWidth="1.5" />
      <circle cx="16" cy="16" r="6" fill={accentColor} opacity="0.3" />
      <path d="M26 16 L38 10 M26 16 L38 16 M26 16 L38 22" stroke={accentColor} strokeWidth="1.5" />
      <circle cx="40" cy="10" r="3" fill={accentColor} opacity="0.7" />
      <circle cx="42" cy="16" r="3" fill={accentColor} opacity="0.7" />
      <circle cx="40" cy="22" r="3" fill={accentColor} opacity="0.7" />
    </svg>
  );
}

function LysogenicSwitchThumbnail({ accentColor, mutedColor }: ThumbnailProps): React.ReactElement {
  return (
    <svg width="48" height="32" viewBox="0 0 48 32">
      <path d="M4 16 Q12 8 20 16 Q28 24 36 16 L44 16" fill="none" stroke={accentColor} strokeWidth="2" />
      <circle cx="20" cy="16" r="4" fill={mutedColor} />
      <path d="M18 14 L22 18 M18 18 L22 14" stroke={accentColor} strokeWidth="1.5" />
    </svg>
  );
}

function BurstSizeThumbnail({ accentColor, mutedColor }: ThumbnailProps): React.ReactElement {
  return (
    <svg width="48" height="32" viewBox="0 0 48 32">
      <path d="M4 28 L12 24 L20 20 L28 12 L36 6 L44 4" fill="none" stroke={accentColor} strokeWidth="2" />
      <rect x="4" y="28" width="6" height="2" fill={mutedColor} opacity="0.5" />
      <rect x="12" y="24" width="6" height="6" fill={mutedColor} opacity="0.5" />
      <rect x="20" y="18" width="6" height="12" fill={mutedColor} opacity="0.5" />
      <rect x="28" y="10" width="6" height="20" fill={mutedColor} opacity="0.6" />
      <rect x="36" y="4" width="6" height="26" fill={accentColor} opacity="0.4" />
    </svg>
  );
}

function PopulationDynamicsThumbnail({ accentColor, mutedColor }: ThumbnailProps): React.ReactElement {
  return (
    <svg width="48" height="32" viewBox="0 0 48 32">
      <path d="M4 20 Q12 24 20 18 Q28 12 36 16 Q42 18 44 14" fill="none" stroke={accentColor} strokeWidth="2" />
      <path d="M4 12 Q12 8 20 14 Q28 20 36 16 Q42 14 44 18" fill="none" stroke={mutedColor} strokeWidth="1.5" strokeDasharray="3,2" />
    </svg>
  );
}

function CoinfectionThumbnail({ accentColor, mutedColor }: ThumbnailProps): React.ReactElement {
  return (
    <svg width="48" height="32" viewBox="0 0 48 32">
      <circle cx="16" cy="16" r="8" fill="none" stroke={accentColor} strokeWidth="1.5" />
      <circle cx="32" cy="16" r="8" fill="none" stroke={mutedColor} strokeWidth="1.5" />
      <path d="M20 12 L28 20 M28 12 L20 20" stroke={accentColor} strokeWidth="2" opacity="0.7" />
    </svg>
  );
}

function DNAPackagingThumbnail({ accentColor, mutedColor }: ThumbnailProps): React.ReactElement {
  return (
    <svg width="48" height="32" viewBox="0 0 48 32">
      <rect x="8" y="8" width="16" height="16" rx="2" fill="none" stroke={mutedColor} strokeWidth="1.5" />
      <path d="M28 16 L36 12 L36 20 Z" fill={accentColor} />
      <path d="M12 12 L20 12 M12 16 L20 16 M12 20 L18 20" stroke={accentColor} strokeWidth="1.5" />
      <circle cx="40" cy="16" r="4" fill={accentColor} opacity="0.5" />
    </svg>
  );
}

function TranscriptionThumbnail({ accentColor, mutedColor }: ThumbnailProps): React.ReactElement {
  return (
    <svg width="48" height="32" viewBox="0 0 48 32">
      <rect x="4" y="14" width="40" height="4" rx="1" fill={mutedColor} opacity="0.3" />
      <rect x="8" y="14" width="8" height="4" fill={accentColor} opacity="0.8" />
      <rect x="20" y="14" width="6" height="4" fill={accentColor} opacity="0.6" />
      <rect x="30" y="14" width="10" height="4" fill={accentColor} opacity="0.4" />
      <path d="M12 10 L12 14 M24 10 L24 14 M36 10 L36 14" stroke={accentColor} strokeWidth="1" />
    </svg>
  );
}

function ReceptorBindingThumbnail({ accentColor, mutedColor }: ThumbnailProps): React.ReactElement {
  return (
    <svg width="48" height="32" viewBox="0 0 48 32">
      <circle cx="14" cy="16" r="8" fill="none" stroke={accentColor} strokeWidth="1.5" />
      <path d="M14 12 L14 8 M10 14 L6 12 M18 14 L22 12" stroke={accentColor} strokeWidth="1" />
      <rect x="30" y="10" width="12" height="12" rx="2" fill="none" stroke={mutedColor} strokeWidth="1.5" />
      <path d="M22 16 L30 16" stroke={accentColor} strokeWidth="1.5" strokeDasharray="2,2" />
    </svg>
  );
}

function ResistanceEvolutionThumbnail({ accentColor, mutedColor }: ThumbnailProps): React.ReactElement {
  return (
    <svg width="48" height="32" viewBox="0 0 48 32">
      <path d="M4 26 L14 20 L24 24 L34 14 L44 10" fill="none" stroke={accentColor} strokeWidth="2" />
      <circle cx="14" cy="20" r="2" fill={accentColor} />
      <circle cx="24" cy="24" r="2" fill={accentColor} />
      <circle cx="34" cy="14" r="2" fill={accentColor} />
      <path d="M4 8 L14 12 L24 8 L34 18 L44 22" fill="none" stroke={mutedColor} strokeWidth="1.5" strokeDasharray="3,2" />
    </svg>
  );
}

function RecombinationThumbnail({ accentColor, mutedColor }: ThumbnailProps): React.ReactElement {
  return (
    <svg width="48" height="32" viewBox="0 0 48 32">
      <path d="M4 10 L20 10 L28 22 L44 22" fill="none" stroke={accentColor} strokeWidth="2" />
      <path d="M4 22 L20 22 L28 10 L44 10" fill="none" stroke={mutedColor} strokeWidth="1.5" />
      <circle cx="24" cy="16" r="3" fill={accentColor} opacity="0.5" />
    </svg>
  );
}

function getSimulationThumbnail(simId: string, colors: ThumbnailProps): React.ReactElement | null {
  switch (simId) {
    case 'lysogeny-circuit': return <LysogenicSwitchThumbnail {...colors} />;
    case 'ribosome-traffic': return <TranscriptionThumbnail {...colors} />;
    case 'plaque-automata': return <CoinfectionThumbnail {...colors} />;
    case 'evolution-replay': return <ResistanceEvolutionThumbnail {...colors} />;
    case 'packaging-motor': return <DNAPackagingThumbnail {...colors} />;
    case 'infection-kinetics': return <PopulationDynamicsThumbnail {...colors} />;
    default: return null;
  }
}

const SIMULATIONS: SimulationDef[] = SIMULATION_METADATA.map((m, idx) => ({
  id: m.id,
  label: m.name,
  description: m.description,
  icon: m.icon,
  shortcut: String((idx + 1) % 10), // 1-9 then 0
  category: m.requiresPhage ? 'Phage-Aware' : 'General',
  complexity: m.priority <= 2 ? 'simple' : m.priority <= 4 ? 'moderate' : 'complex',
  priority: m.priority,
}));

export function SimulationHub(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle, close, open, setOverlayData } = useOverlay();
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Sort by priority, fall back to label
  const orderedSims = useMemo(
    () => [...SIMULATIONS].sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label)),
    []
  );

  // Register hotkey
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'S' && e.shiftKey && !e.ctrlKey && !e.metaKey && !isOpen('simulationHub')) {
        e.preventDefault();
        toggle('simulationHub');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle, isOpen]);

  // Handle keyboard navigation
  useEffect(() => {
    if (!isOpen('simulationHub')) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
        case 'j':
          e.preventDefault();
          setSelectedIndex(prev => Math.min(prev + 1, orderedSims.length - 1));
          break;
        case 'ArrowUp':
        case 'k':
          e.preventDefault();
          setSelectedIndex(prev => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          const sim = orderedSims[selectedIndex];
          setOverlayData('simulationView.simId', sim.id);
          close('simulationHub');
          open('simulationView');
          break;
        default:
          // Check for shortcut key (1-9, 0)
          if (/^[0-9]$/.test(e.key)) {
            const matchingSim = orderedSims.find(s => s.shortcut === e.key);
            if (matchingSim) {
              e.preventDefault();
              setOverlayData('simulationView.simId', matchingSim.id);
              close('simulationHub');
              open('simulationView');
            }
          }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, close, open, orderedSims, setOverlayData]);

  if (!isOpen('simulationHub')) {
    return null;
  }

  // Group by category
  const grouped = orderedSims.reduce((acc, sim) => {
    if (!acc[sim.category]) {
      acc[sim.category] = [];
    }
    acc[sim.category].push(sim);
    return acc;
  }, {} as Record<string, SimulationDef[]>);

  let flatIndex = 0;

  const getComplexityColor = (complexity?: string) => {
    switch (complexity) {
      case 'simple': return colors.success;
      case 'moderate': return colors.warning;
      case 'complex': return colors.error;
      default: return colors.textMuted;
    }
  };

  return (
    <Overlay
      id="simulationHub"
      title="SIMULATION HUB"
      icon="🧪"
      hotkey="S"
      size="xl"
    >
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))',
        gap: '1rem',
      }}>
        {Object.entries(grouped).map(([category, sims]) => (
          <div
            key={category}
            style={{
              border: `1px solid ${colors.borderLight}`,
              borderRadius: '4px',
              overflow: 'hidden',
            }}
          >
            {/* Category header */}
            <div style={{
              backgroundColor: colors.backgroundAlt,
              padding: '0.5rem 0.75rem',
              borderBottom: `1px solid ${colors.borderLight}`,
            }}>
              <span style={{ color: colors.primary, fontWeight: 'bold' }}>
                {category}
              </span>
            </div>

            {/* Simulations */}
            <div>
              {sims.map((sim) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;

                const thumbnailColors: ThumbnailProps = {
                  accentColor: colors.accent,
                  mutedColor: colors.textMuted,
                };
                const thumbnail = getSimulationThumbnail(sim.id, thumbnailColors);

                return (
                  <div
                    key={sim.id}
                    onClick={() => {
                      setOverlayData('simulationView.simId', sim.id);
                      close('simulationHub');
                      open('simulationView');
                    }}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: '0.75rem',
                      padding: '0.75rem',
                      cursor: 'pointer',
                      backgroundColor: isSelected ? colors.backgroundAlt : 'transparent',
                      borderLeft: isSelected ? `3px solid ${colors.accent}` : '3px solid transparent',
                      borderBottom: `1px solid ${colors.borderLight}`,
                    }}
                  >
                    {/* Preview thumbnail or fallback to emoji */}
                    <div style={{
                      width: '48px',
                      height: '32px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      backgroundColor: colors.background,
                      borderRadius: '4px',
                      border: `1px solid ${colors.borderLight}`,
                      flexShrink: 0,
                    }}>
                      {thumbnail || <span style={{ fontSize: '1.25rem' }}>{sim.icon}</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}>
                        <span style={{
                          color: isSelected ? colors.text : colors.textDim,
                          fontWeight: isSelected ? 'bold' : 'normal',
                        }}>
                          {sim.label}
                        </span>
                        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                          {sim.duration && (
                            <span style={{
                              color: colors.textMuted,
                              fontSize: '0.75rem',
                            }}>
                              {sim.duration}
                            </span>
                          )}
                          <span style={{
                            color: colors.accent,
                            fontSize: '0.8rem',
                            padding: '0.1rem 0.4rem',
                            backgroundColor: colors.background,
                            border: `1px solid ${colors.borderLight}`,
                            borderRadius: '3px',
                            fontFamily: 'monospace',
                          }}>
                            {sim.shortcut}
                          </span>
                        </div>
                      </div>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginTop: '0.25rem',
                      }}>
                        <span style={{
                          color: colors.textMuted,
                          fontSize: '0.85rem',
                        }}>
                          {sim.description}
                        </span>
                        {sim.complexity && (
                          <span style={{
                            color: getComplexityColor(sim.complexity),
                            fontSize: '0.7rem',
                            textTransform: 'uppercase',
                          }}>
                            {sim.complexity}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginTop: '1rem',
        padding: '0.75rem',
        borderTop: `1px solid ${colors.borderLight}`,
      }}>
        <div style={{
          display: 'flex',
          gap: '1rem',
          color: colors.textMuted,
          fontSize: '0.75rem',
        }}>
          <span>↑↓ Navigate</span>
          <span>Enter or number key to launch</span>
          <span>ESC to close</span>
        </div>
        <div style={{
          display: 'flex',
          gap: '1rem',
          fontSize: '0.75rem',
        }}>
          <span style={{ color: colors.success }}>● Simple</span>
          <span style={{ color: colors.warning }}>● Moderate</span>
          <span style={{ color: colors.error }}>● Complex</span>
        </div>
      </div>
    </Overlay>
  );
}

export default SimulationHub;
