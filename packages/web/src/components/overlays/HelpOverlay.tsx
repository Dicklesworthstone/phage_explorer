/**
 * HelpOverlay - Dynamic Hotkey Reference
 *
 * Shows all available keyboard shortcuts organized by category.
 * Matches the TUI HelpOverlay design.
 */

import React, { useState, useEffect } from 'react';
import { useTheme } from '../../hooks/useTheme';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';

interface HotkeyInfo {
  key: string;
  description: string;
  category: string;
}

// All hotkeys organized by category
const HOTKEYS: HotkeyInfo[] = [
  // Navigation
  { key: 'j / ↓', description: 'Next phage', category: 'Navigation' },
  { key: 'k / ↑', description: 'Previous phage', category: 'Navigation' },
  { key: 'h / ←', description: 'Scroll left', category: 'Navigation' },
  { key: 'l / →', description: 'Scroll right', category: 'Navigation' },
  { key: 'gg', description: 'Go to first phage', category: 'Navigation' },
  { key: 'G', description: 'Go to last phage', category: 'Navigation' },
  { key: 'Ctrl+g', description: 'Go to position', category: 'Navigation' },
  { key: 'Home', description: 'Scroll to start', category: 'Navigation' },
  { key: 'End', description: 'Scroll to end', category: 'Navigation' },
  { key: 'PgUp/PgDn', description: 'Page scroll', category: 'Navigation' },

  // View Modes
  { key: 'Space', description: 'Toggle DNA/Amino Acid view', category: 'View' },
  { key: '1 / 2 / 3', description: 'Set reading frame', category: 'View' },
  { key: 'f', description: 'Cycle reading frame', category: 'View' },
  { key: 't', description: 'Cycle theme', category: 'View' },
  { key: 'T', description: 'Theme selector', category: 'View' },
  { key: 'd', description: 'Toggle diff mode', category: 'View' },
  { key: 'm', description: 'Toggle 3D model', category: 'View' },
  { key: 'M', description: '3D model fullscreen', category: 'View' },
  { key: 'z', description: 'Pause/play 3D model', category: 'View' },

  // Overlays & Search
  { key: 's / /', description: 'Open search', category: 'Search' },
  { key: '?', description: 'Show help (this)', category: 'Overlays' },
  { key: 'a / A', description: 'Analysis menu', category: 'Overlays' },
  { key: 'S', description: 'Simulation hub', category: 'Overlays' },
  { key: ':', description: 'Command palette', category: 'Overlays' },
  { key: 'c', description: 'Genome comparison', category: 'Overlays' },
  { key: 'ESC', description: 'Close overlay', category: 'Overlays' },

  // Analysis Overlays
  { key: 'g', description: 'GC skew analysis', category: 'Analysis' },
  { key: 'x', description: 'Sequence complexity', category: 'Analysis' },
  { key: 'b', description: 'DNA bendability', category: 'Analysis' },
  { key: 'p', description: 'Promoter/RBS sites', category: 'Analysis' },
  { key: 'r', description: 'Repeat/palindrome finder', category: 'Analysis' },
  { key: 'J', description: 'Codon bias decomposition', category: 'Analysis' },
  { key: 'L', description: 'Phase portrait', category: 'Analysis' },
  { key: 'V', description: 'K-mer anomaly', category: 'Analysis' },
  { key: 'Y', description: 'HGT analysis', category: 'Analysis' },
  { key: '0', description: 'Tropism/receptor atlas', category: 'Analysis' },

  // Comparison
  { key: 'Tab', description: 'Next comparison tab', category: 'Comparison' },
  { key: 'Shift+Tab', description: 'Previous comparison tab', category: 'Comparison' },
  { key: 'A/B', description: 'Select phage A/B', category: 'Comparison' },
  { key: 'X', description: 'Swap phages', category: 'Comparison' },
];

// Group hotkeys by category
function groupByCategory(hotkeys: HotkeyInfo[]): Record<string, HotkeyInfo[]> {
  return hotkeys.reduce((acc, hotkey) => {
    if (!acc[hotkey.category]) {
      acc[hotkey.category] = [];
    }
    acc[hotkey.category].push(hotkey);
    return acc;
  }, {} as Record<string, HotkeyInfo[]>);
}

export function HelpOverlay(): React.ReactElement | null {
  const { theme } = useTheme();
  const colors = theme.colors;
  const { isOpen, toggle } = useOverlay();
  const [detailLevel, setDetailLevel] = useState<'essential' | 'detailed'>('essential');

  // Register hotkey
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '?' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        toggle('help');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle]);

  // Handle detail toggle
  useEffect(() => {
    if (!isOpen('help')) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        setDetailLevel(prev => prev === 'essential' ? 'detailed' : 'essential');
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  if (!isOpen('help')) {
    return null;
  }

  const grouped = groupByCategory(HOTKEYS);
  const categories = detailLevel === 'essential'
    ? ['Navigation', 'View', 'Search', 'Overlays']
    : Object.keys(grouped);

  return (
    <Overlay
      id="help"
      title="KEYBOARD SHORTCUTS"
      icon="⌨"
      hotkey="?"
      size="lg"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        {/* Detail level toggle */}
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0.5rem',
          backgroundColor: colors.backgroundAlt,
          borderRadius: '4px',
        }}>
          <span style={{ color: colors.textDim }}>
            Showing: {detailLevel === 'essential' ? 'Essential' : 'All'} shortcuts
          </span>
          <button
            onClick={() => setDetailLevel(prev => prev === 'essential' ? 'detailed' : 'essential')}
            style={{
              background: colors.accent,
              color: colors.background,
              border: 'none',
              padding: '0.25rem 0.75rem',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '0.85rem',
            }}
          >
            Press D to toggle
          </button>
        </div>

        {/* Categories */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: '1rem',
        }}>
          {categories.map(category => (
            <div
              key={category}
              style={{
                border: `1px solid ${colors.borderLight}`,
                borderRadius: '4px',
                overflow: 'hidden',
              }}
            >
              <div style={{
                backgroundColor: colors.backgroundAlt,
                padding: '0.5rem 0.75rem',
                borderBottom: `1px solid ${colors.borderLight}`,
              }}>
                <span style={{ color: colors.primary, fontWeight: 'bold' }}>
                  {category}
                </span>
              </div>
              <div style={{ padding: '0.5rem' }}>
                {grouped[category]?.map((hotkey, index) => (
                  <div
                    key={index}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      padding: '0.25rem 0.5rem',
                      borderRadius: '2px',
                      backgroundColor: index % 2 === 0 ? 'transparent' : colors.backgroundAlt,
                    }}
                  >
                    <span style={{
                      color: colors.accent,
                      fontFamily: 'monospace',
                      fontSize: '0.9rem',
                      minWidth: '80px',
                    }}>
                      {hotkey.key}
                    </span>
                    <span style={{ color: colors.text, flex: 1, marginLeft: '1rem' }}>
                      {hotkey.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Overlay>
  );
}

export default HelpOverlay;
