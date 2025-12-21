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
import {
  IconAlertTriangle,
  IconAperture,
  IconBookmark,
  IconCube,
  IconDiff,
  IconDna,
  IconLayers,
  IconMagnet,
  IconRepeat,
  IconSearch,
  IconShield,
  IconTarget,
  IconTrendingUp,
} from '../ui';

const ITEM_ICON_SIZE = 18;

interface AnalysisItem {
  id: string;
  overlayId: OverlayId;
  label: string;
  description: string;
  icon: React.ReactNode;
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
    icon: <IconTrendingUp size={ITEM_ICON_SIZE} />,
    shortcut: 'g',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },
  {
    id: 'complexity',
    overlayId: 'complexity',
    label: 'Sequence Complexity',
    description: 'Shannon entropy and linguistic complexity',
    icon: <IconCube size={ITEM_ICON_SIZE} />,
    shortcut: 'x',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },
  {
    id: 'bendability',
    overlayId: 'bendability',
    label: 'DNA Bendability',
    description: 'Curvature and flexibility prediction',
    icon: <IconAperture size={ITEM_ICON_SIZE} />,
    shortcut: 'b',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },
  {
    id: 'packaging-pressure',
    overlayId: 'pressure',
    label: 'Packaging Pressure',
    description: 'Capsid fill fraction, force, and pressure gauge',
    icon: <IconMagnet size={ITEM_ICON_SIZE} />,
    shortcut: 'v',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },
  {
    id: 'virion-stability',
    overlayId: 'stability',
    label: 'Virion Stability',
    description: 'Capsid robustness vs temperature / salt',
    icon: <IconShield size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+V',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },
  {
    id: 'hilbert',
    overlayId: 'hilbert',
    label: 'Hilbert Curve',
    description: 'Space-filling curve view of genome composition',
    icon: <IconAperture size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+Shift+H',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },
  {
    id: 'sequence-logo',
    overlayId: 'logo',
    label: 'Sequence Logo',
    description: 'Gene-start motif logo from real CDS start windows',
    icon: <IconBookmark size={ITEM_ICON_SIZE} />,
    shortcut: 'o',
    category: 'Sequence Analysis',
    requiresLevel: 'intermediate',
  },
  {
    id: 'fold-quickview',
    overlayId: 'foldQuickview',
    label: 'Fold Quickview',
    description: 'Protein embedding novelty + nearest neighbors',
    icon: <IconAperture size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+Shift+F',
    category: 'Sequence Analysis',
    requiresLevel: 'power',
  },
  {
    id: 'periodicity',
    overlayId: 'periodicity',
    label: 'Periodicity Spectrogram',
    description: 'Windowed autocorrelation heatmap + tandem repeat candidates',
    icon: <IconRepeat size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+W',
    category: 'Sequence Analysis',
    requiresLevel: 'power',
  },

  // Gene Features
  {
    id: 'promoter',
    overlayId: 'promoter',
    label: 'Promoter/RBS Sites',
    description: 'Predicted promoters and ribosome binding sites',
    icon: <IconTarget size={ITEM_ICON_SIZE} />,
    shortcut: 'p',
    category: 'Gene Features',
    requiresLevel: 'intermediate',
  },
  {
    id: 'repeats',
    overlayId: 'repeats',
    label: 'Repeats & Palindromes',
    description: 'Direct, inverted, and palindromic sequences',
    icon: <IconRepeat size={ITEM_ICON_SIZE} />,
    shortcut: 'r',
    category: 'Gene Features',
    requiresLevel: 'intermediate',
  },
  {
    id: 'module-coherence',
    overlayId: 'modules',
    label: 'Module Coherence',
    description: 'Functional module completeness & stoichiometry',
    icon: <IconLayers size={ITEM_ICON_SIZE} />,
    shortcut: 'l',
    category: 'Gene Features',
    requiresLevel: 'intermediate',
  },

  // Codon Analysis
  {
    id: 'rna-structure',
    overlayId: 'rnaStructure',
    label: 'RNA Structure Explorer',
    description: 'Synonymous stress analysis & regulatory element detection',
    icon: <IconDna size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+R',
    category: 'Codon Analysis',
    requiresLevel: 'power',
  },
  {
    id: 'bias',
    overlayId: 'biasDecomposition',
    label: 'Codon Bias Decomposition',
    description: 'Principal component analysis of codon usage',
    icon: <IconTrendingUp size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+B',
    category: 'Codon Analysis',
    requiresLevel: 'power',
  },
  {
    id: 'phase',
    overlayId: 'phasePortrait',
    label: 'Phase Portrait',
    description: 'Codon usage phase space visualization',
    icon: <IconAperture size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+Shift+P',
    category: 'Codon Analysis',
    requiresLevel: 'power',
  },

  // Evolutionary Analysis
  {
    id: 'epistasis',
    overlayId: 'epistasis',
    label: 'Epistasis Explorer',
    description: 'Fitness landscape & compensatory mutation analysis',
    icon: <IconLayers size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+E',
    category: 'Evolutionary',
    requiresLevel: 'power',
  },
  {
    id: 'kmer',
    overlayId: 'kmerAnomaly',
    label: 'K-mer Anomaly',
    description: 'Unusual k-mer composition detection',
    icon: <IconSearch size={ITEM_ICON_SIZE} />,
    shortcut: 'j',
    category: 'Evolutionary',
    requiresLevel: 'power',
  },
  {
    id: 'anomaly',
    overlayId: 'anomaly',
    label: 'Anomaly Detection',
    description: 'Composite anomalies (KL, compression, skews, bias)',
    icon: <IconAlertTriangle size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+Y',
    category: 'Evolutionary',
    requiresLevel: 'power',
  },
  {
    id: 'hgt',
    overlayId: 'hgt',
    label: 'HGT Analysis',
    description: 'Horizontal gene transfer detection',
    icon: <IconDiff size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+H',
    category: 'Evolutionary',
    requiresLevel: 'power',
  },
  {
    id: 'prophage-excision',
    overlayId: 'prophageExcision',
    label: 'Prophage Excision',
    description: 'Predict attL/attR sites and model excision product',
    icon: <IconRepeat size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+X',
    category: 'Evolutionary',
    requiresLevel: 'power',
  },

  // Host Interaction
  {
    id: 'tropism',
    overlayId: 'tropism',
    label: 'Tropism & Receptors',
    description: 'Host receptor binding predictions',
    icon: <IconTarget size={ITEM_ICON_SIZE} />,
    shortcut: '0',
    category: 'Host Interaction',
    requiresLevel: 'power',
  },
  {
    id: 'crispr',
    overlayId: 'crispr',
    label: 'CRISPR Spacers',
    description: 'CRISPR spacer matches in phage genome',
    icon: <IconDna size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+C',
    category: 'Host Interaction',
    requiresLevel: 'power',
  },

  // Comparative Analysis
  {
    id: 'synteny',
    overlayId: 'synteny',
    label: 'Synteny Analysis',
    description: 'Gene order conservation between phage genomes',
    icon: <IconLayers size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+S',
    category: 'Comparative',
    requiresLevel: 'power',
  },
  {
    id: 'dot-plot',
    overlayId: 'dotPlot',
    label: 'Dot Plot',
    description: 'Self-similarity matrix for repeats and palindromes',
    icon: <IconDiff size={ITEM_ICON_SIZE} />,
    shortcut: 'Alt+O',
    category: 'Comparative',
    requiresLevel: 'intermediate',
  },

  // Reference
  {
    id: 'aa-key',
    overlayId: 'aaKey',
    label: 'Amino Acid Key',
    description: 'Color legend for amino acids by property',
    icon: <IconDna size={ITEM_ICON_SIZE} />,
    shortcut: 'k',
    category: 'Reference',
    requiresLevel: 'novice',
  },
  {
    id: 'aa-legend',
    overlayId: 'aaLegend',
    label: 'Amino Acid Legend (compact)',
    description: 'Compact amino acid color legend',
    icon: <IconBookmark size={ITEM_ICON_SIZE} />,
    shortcut: 'l',
    category: 'Reference',
    requiresLevel: 'novice',
  },

  ...(import.meta.env.DEV
    ? ([
        {
          id: 'gpu-wasm-benchmark',
          overlayId: 'gpuWasmBenchmark',
          label: 'GPU vs WASM Benchmark',
          description: 'Measure WebGPU vs WASM timings (dev-only)',
          icon: <IconCube size={ITEM_ICON_SIZE} />,
          shortcut: 'Alt+Shift+B',
          category: 'Dev',
          requiresLevel: 'power',
        },
      ] satisfies AnalysisItem[])
    : []),
];

function parseShortcut(shortcut: string): {
  key: string;
  alt: boolean;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
} | null {
  const trimmed = shortcut.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('+').map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return null;
  const key = parts.pop()!;
  const modifiers = new Set(parts.map((part) => part.toLowerCase()));

  return {
    key,
    alt: modifiers.has('alt'),
    shift: modifiers.has('shift'),
    ctrl: modifiers.has('ctrl') || modifiers.has('control'),
    meta: modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('command'),
  };
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;
  if (event.altKey !== parsed.alt) return false;
  if (event.shiftKey !== parsed.shift) return false;
  if (event.ctrlKey !== parsed.ctrl) return false;
  if (event.metaKey !== parsed.meta) return false;

  const expectedKey = parsed.key.length === 1 ? parsed.key.toLowerCase() : parsed.key.toLowerCase();
  const actualKey = event.key.length === 1 ? event.key.toLowerCase() : event.key.toLowerCase();
  return expectedKey === actualKey;
}

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
          const matchingItem = ANALYSIS_ITEMS.find((item) => matchesShortcut(e, item.shortcut));
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
                    <span className="analysis-menu-item-icon" aria-hidden="true">
                      {item.icon}
                    </span>
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
