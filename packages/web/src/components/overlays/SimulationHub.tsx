/**
 * SimulationHub - Modal Launcher
 *
 * A modal for launching and configuring simulations.
 * Matches the TUI SimulationMenuOverlay pattern.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';

interface SimulationDef {
  id: string;
  label: string;
  description: string;
  icon: string;
  shortcut: string;
  category: string;
  duration?: string;
  complexity?: 'simple' | 'moderate' | 'complex';
}

const SIMULATIONS: SimulationDef[] = [
  // Infection Dynamics
  {
    id: 'lytic-cycle',
    label: 'Lytic Cycle',
    description: 'Visualize the complete lytic infection cycle',
    icon: '💥',
    shortcut: '1',
    category: 'Infection Dynamics',
    duration: '~30s',
    complexity: 'simple',
  },
  {
    id: 'lysogenic-switch',
    label: 'Lysogenic Switch',
    description: 'Lambda-style lysogeny decision circuit',
    icon: '⚡',
    shortcut: '2',
    category: 'Infection Dynamics',
    duration: '~45s',
    complexity: 'moderate',
  },
  {
    id: 'burst-size',
    label: 'Burst Size Dynamics',
    description: 'Progeny production over time',
    icon: '📊',
    shortcut: '3',
    category: 'Infection Dynamics',
    duration: '~20s',
    complexity: 'simple',
  },

  // Population Dynamics
  {
    id: 'population-dynamics',
    label: 'Population Dynamics',
    description: 'Phage-bacteria population model',
    icon: '📈',
    shortcut: '4',
    category: 'Population Dynamics',
    duration: '~60s',
    complexity: 'moderate',
  },
  {
    id: 'coinfection',
    label: 'Coinfection Competition',
    description: 'Multiple phage strain competition',
    icon: '⚔️',
    shortcut: '5',
    category: 'Population Dynamics',
    duration: '~90s',
    complexity: 'complex',
  },

  // Molecular Processes
  {
    id: 'dna-packaging',
    label: 'DNA Packaging',
    description: 'Headful packaging motor simulation',
    icon: '📦',
    shortcut: '6',
    category: 'Molecular Processes',
    duration: '~40s',
    complexity: 'moderate',
  },
  {
    id: 'transcription',
    label: 'Transcription Flow',
    description: 'Gene expression temporal program',
    icon: '🔄',
    shortcut: '7',
    category: 'Molecular Processes',
    duration: '~50s',
    complexity: 'moderate',
  },
  {
    id: 'receptor-binding',
    label: 'Receptor Binding',
    description: 'Tail fiber-receptor docking simulation',
    icon: '🎯',
    shortcut: '8',
    category: 'Molecular Processes',
    duration: '~25s',
    complexity: 'simple',
  },

  // Evolution
  {
    id: 'resistance-evolution',
    label: 'Resistance Evolution',
    description: 'Host resistance/phage counter-adaptation',
    icon: '🧬',
    shortcut: '9',
    category: 'Evolution',
    duration: '~120s',
    complexity: 'complex',
  },
  {
    id: 'recombination',
    label: 'Recombination Events',
    description: 'Genetic exchange between phages',
    icon: '🔀',
    shortcut: '0',
    category: 'Evolution',
    duration: '~60s',
    complexity: 'moderate',
  },
];

export function SimulationHub(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle, close, open } = useOverlay();
  const [selectedIndex, setSelectedIndex] = useState(0);

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
          setSelectedIndex(prev => Math.min(prev + 1, SIMULATIONS.length - 1));
          break;
        case 'ArrowUp':
        case 'k':
          e.preventDefault();
          setSelectedIndex(prev => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          const sim = SIMULATIONS[selectedIndex];
          // Launch simulation (would connect to simulation engine)
          console.log('Launching simulation:', sim.id);
          close('simulationHub');
          open('simulationView');
          break;
        default:
          // Check for shortcut key (1-9, 0)
          if (/^[0-9]$/.test(e.key)) {
            const matchingSim = SIMULATIONS.find(s => s.shortcut === e.key);
            if (matchingSim) {
              e.preventDefault();
              console.log('Launching simulation:', matchingSim.id);
              close('simulationHub');
              open('simulationView');
            }
          }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, close, open]);

  if (!isOpen('simulationHub')) {
    return null;
  }

  // Group by category
  const grouped = SIMULATIONS.reduce((acc, sim) => {
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

                return (
                  <div
                    key={sim.id}
                    onClick={() => {
                      console.log('Launching simulation:', sim.id);
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
                    <span style={{ fontSize: '1.5rem' }}>{sim.icon}</span>
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
