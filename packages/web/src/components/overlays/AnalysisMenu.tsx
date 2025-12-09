/**
 * AnalysisMenu - Drawer Component
 *
 * A drawer menu showing all available analysis options organized by category.
 * Keyboard-navigable with hotkey hints.
 */

import React, { useState, useEffect } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay, type OverlayId } from './OverlayProvider';

interface AnalysisItem {
  id: string;
  overlayId: OverlayId;
  label: string;
  description: string;
  icon: string;
  shortcut: string;
  category: string;
  requiresLevel?: 'novice' | 'intermediate' | 'power';
}

const ANALYSIS_ITEMS: AnalysisItem[] = [
  // Sequence Analysis
  {
    id: 'gc-skew',
    overlayId: 'gcSkew',
    label: 'GC Skew',
    description: 'Cumulative GC skew plot for origin/terminus detection',
    icon: '📈',
    shortcut: 'g',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },
  {
    id: 'complexity',
    overlayId: 'complexity',
    label: 'Sequence Complexity',
    description: 'Shannon entropy and linguistic complexity',
    icon: '🎲',
    shortcut: 'x',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },
  {
    id: 'bendability',
    overlayId: 'bendability',
    label: 'DNA Bendability',
    description: 'Curvature and flexibility prediction',
    icon: '🌀',
    shortcut: 'b',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },
  {
    id: 'packaging-pressure',
    overlayId: 'pressure',
    label: 'Packaging Pressure',
    description: 'Capsid fill fraction, force, and pressure gauge',
    icon: '🧲',
    shortcut: 'v',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },
  {
    id: 'virion-stability',
    overlayId: 'stability',
    label: 'Virion Stability',
    description: 'Capsid robustness vs temperature / salt',
    icon: '🛡️',
    shortcut: 'Alt+V',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },
  {
    id: 'hilbert',
    overlayId: 'hilbert',
    label: 'Hilbert Curve',
    description: 'Space-filling curve view of genome composition',
    icon: '🌀',
    shortcut: 'H',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },

  // Gene Features
  {
    id: 'promoter',
    overlayId: 'promoter',
    label: 'Promoter/RBS Sites',
    description: 'Predicted promoters and ribosome binding sites',
    icon: '🎯',
    shortcut: 'p',
    category: 'Gene Features',
    requiresLevel: 'intermediate',
  },
  {
    id: 'repeats',
    overlayId: 'repeats',
    label: 'Repeats & Palindromes',
    description: 'Direct, inverted, and palindromic sequences',
    icon: '🔄',
    shortcut: 'r',
    category: 'Gene Features',
    requiresLevel: 'intermediate',
  },

  // Codon Analysis
  {
    id: 'bias',
    overlayId: 'biasDecomposition',
    label: 'Codon Bias Decomposition',
    description: 'Principal component analysis of codon usage',
    icon: '📊',
    shortcut: 'J',
    category: 'Codon Analysis',
    requiresLevel: 'power',
  },
  {
    id: 'phase',
    overlayId: 'phasePortrait',
    label: 'Phase Portrait',
    description: 'Codon usage phase space visualization',
    icon: '🌐',
    shortcut: 'L',
    category: 'Codon Analysis',
    requiresLevel: 'power',
  },

  // Evolutionary Analysis
  {
    id: 'kmer',
    overlayId: 'kmerAnomaly',
    label: 'K-mer Anomaly',
    description: 'Unusual k-mer composition detection',
    icon: '🔍',
    shortcut: 'V',
    category: 'Evolutionary',
    requiresLevel: 'power',
  },
  {
    id: 'anomaly',
    overlayId: 'anomaly',
    label: 'Anomaly Detection',
    description: 'Composite anomalies (KL, compression, skews, bias)',
    icon: '⚠️',
    shortcut: 'A',
    category: 'Evolutionary',
    requiresLevel: 'power',
  },
  {
    id: 'hgt',
    overlayId: 'hgt',
    label: 'HGT Analysis',
    description: 'Horizontal gene transfer detection',
    icon: '↔️',
    shortcut: 'Y',
    category: 'Evolutionary',
    requiresLevel: 'power',
  },

  // Host Interaction
  {
    id: 'tropism',
    overlayId: 'tropism',
    label: 'Tropism & Receptors',
    description: 'Host receptor binding predictions',
    icon: '🎯',
    shortcut: '0',
    category: 'Host Interaction',
    requiresLevel: 'power',
  },
  {
    id: 'crispr',
    overlayId: 'crispr',
    label: 'CRISPR Spacers',
    description: 'CRISPR spacer matches in phage genome',
    icon: '✂️',
    shortcut: 'C',
    category: 'Host Interaction',
    requiresLevel: 'power',
  },

  // Comparative Analysis
  {
    id: 'synteny',
    overlayId: 'synteny',
    label: 'Synteny Analysis',
    description: 'Gene order conservation between phage genomes',
    icon: '🧩',
    shortcut: 'Alt+S',
    category: 'Comparative',
    requiresLevel: 'power',
  },
  {
    id: 'dot-plot',
    overlayId: 'dotPlot',
    label: 'Dot Plot',
    description: 'Self-similarity matrix for repeats and palindromes',
    icon: '⬛',
    shortcut: 'Alt+D',
    category: 'Comparative',
    requiresLevel: 'intermediate',
  },

  // Reference
  {
    id: 'aa-key',
    overlayId: 'aaKey',
    label: 'Amino Acid Key',
    description: 'Color legend for amino acids by property',
    icon: '🧬',
    shortcut: 'k',
    category: 'Reference',
    requiresLevel: 'novice',
  },
  {
    id: 'aa-legend',
    overlayId: 'aaLegend',
    label: 'Amino Acid Legend (compact)',
    description: 'Compact amino acid color legend',
    icon: '🔖',
    shortcut: 'l',
    category: 'Reference',
    requiresLevel: 'novice',
  },
];

export function AnalysisMenu(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle, open, close } = useOverlay();
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Register hotkey
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.key === 'a' || e.key === 'A') && !e.ctrlKey && !e.metaKey && !isOpen('analysisMenu')) {
        e.preventDefault();
        toggle('analysisMenu');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle, isOpen]);

  // Handle keyboard navigation
  useEffect(() => {
    if (!isOpen('analysisMenu')) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
        case 'j':
          e.preventDefault();
          setSelectedIndex(prev => Math.min(prev + 1, ANALYSIS_ITEMS.length - 1));
          break;
        case 'ArrowUp':
        case 'k':
          e.preventDefault();
          setSelectedIndex(prev => Math.max(prev - 1, 0));
          break;
        case 'Enter':
          e.preventDefault();
          const item = ANALYSIS_ITEMS[selectedIndex];
          close('analysisMenu');
          open(item.overlayId);
          break;
        default:
          // Check for shortcut key
          const matchingItem = ANALYSIS_ITEMS.find(item => item.shortcut === e.key);
          if (matchingItem) {
            e.preventDefault();
            close('analysisMenu');
            open(matchingItem.overlayId);
          }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, close, open]);

  if (!isOpen('analysisMenu')) {
    return null;
  }

  // Group items by category
  const grouped = ANALYSIS_ITEMS.reduce((acc, item) => {
    if (!acc[item.category]) {
      acc[item.category] = [];
    }
    acc[item.category].push(item);
    return acc;
  }, {} as Record<string, AnalysisItem[]>);

  let flatIndex = 0;

  return (
    <Overlay
      id="analysisMenu"
      title="ANALYSIS MENU"
      icon="🔬"
      hotkey="a"
      size="lg"
    >
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))',
        gap: '1rem',
      }}>
        {Object.entries(grouped).map(([category, items]) => (
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

            {/* Items */}
            <div>
              {items.map((item) => {
                const currentIndex = flatIndex++;
                const isSelected = currentIndex === selectedIndex;

                return (
                  <div
                    key={item.id}
                    onClick={() => {
                      close('analysisMenu');
                      open(item.overlayId);
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
                    <span style={{ fontSize: '1.25rem' }}>{item.icon}</span>
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
                          {item.label}
                        </span>
                        <span style={{
                          color: colors.accent,
                          fontSize: '0.8rem',
                          padding: '0.1rem 0.4rem',
                          backgroundColor: colors.background,
                          border: `1px solid ${colors.borderLight}`,
                          borderRadius: '3px',
                          fontFamily: 'monospace',
                        }}>
                          {item.shortcut}
                        </span>
                      </div>
                      <div style={{
                        color: colors.textMuted,
                        fontSize: '0.85rem',
                        marginTop: '0.25rem',
                      }}>
                        {item.description}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      {/* Footer hints */}
      <div style={{
        display: 'flex',
        gap: '1rem',
        marginTop: '1rem',
        padding: '0.5rem',
        borderTop: `1px solid ${colors.borderLight}`,
        color: colors.textMuted,
        fontSize: '0.75rem',
      }}>
        <span>↑↓ or j/k Navigate</span>
        <span>Enter or shortcut key to open</span>
        <span>ESC or a to close</span>
      </div>
    </Overlay>
  );
}

export default AnalysisMenu;
