/**
 * AnalysisSidebar Component
 *
 * A persistent sidebar for large screens that surfaces the 25+ hidden analysis tools
 * organized by category. Previously these were only accessible via keyboard shortcuts.
 */

import React, { useState } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import type { OverlayId } from '@phage-explorer/state';
import {
  IconChevronDown,
  IconChevronRight,
  IconDna,
  IconFlask,
  IconChartBar,
  IconCpu,
  IconGlobe,
  IconShield,
  IconBeaker,
  IconZap,
} from './ui';

interface AnalysisTool {
  id: OverlayId;
  name: string;
  shortcut?: string;
  description: string;
}

interface AnalysisCategory {
  id: string;
  name: string;
  icon: React.ReactNode;
  tools: AnalysisTool[];
  level?: 'novice' | 'intermediate' | 'power';
}

const ANALYSIS_CATEGORIES: AnalysisCategory[] = [
  {
    id: 'sequence',
    name: 'Sequence Analysis',
    icon: <IconDna size={16} />,
    tools: [
      { id: 'gcSkew', name: 'GC Skew', shortcut: 'g', description: 'Origin/terminus detection' },
      { id: 'complexity', name: 'Complexity', shortcut: 'x', description: 'Shannon entropy analysis' },
      { id: 'bendability', name: 'Bendability', shortcut: 'b', description: 'DNA curvature prediction' },
      { id: 'hilbert', name: 'Hilbert Curve', shortcut: 'H', description: 'Space-filling visualization' },
      { id: 'cgr', name: 'Chaos Game', description: 'Fractal genome view' },
      { id: 'dotPlot', name: 'Dotplot', shortcut: '.', description: 'Self-similarity matrix' },
    ],
  },
  {
    id: 'genes',
    name: 'Gene Features',
    icon: <IconFlask size={16} />,
    tools: [
      { id: 'promoter', name: 'Promoters & RBS', shortcut: 'p', description: 'Regulatory elements' },
      { id: 'repeats', name: 'Repeats', shortcut: 'r', description: 'Direct, inverted, palindromic' },
      { id: 'gel', name: 'Virtual Gel', shortcut: 'G', description: 'Restriction digest simulation' },
    ],
  },
  {
    id: 'codon',
    name: 'Codon Analysis',
    icon: <IconChartBar size={16} />,
    level: 'intermediate',
    tools: [
      { id: 'biasDecomposition', name: 'Codon Bias', shortcut: 'J', description: 'PCA of codon usage' },
      { id: 'phasePortrait', name: 'Phase Portrait', shortcut: 'P', description: 'Codon phase space' },
    ],
  },
  {
    id: 'structural',
    name: 'Structural',
    icon: <IconCpu size={16} />,
    level: 'intermediate',
    tools: [
      { id: 'pressure', name: 'Packaging', shortcut: 'v', description: 'Capsid fill & pressure' },
      { id: 'stability', name: 'Stability', description: 'Capsid robustness' },
      { id: 'non-b-dna', name: 'Non-B DNA', description: 'Z-DNA, G-quadruplexes' },
      { id: 'structureConstraints', name: 'Structure Constraints', description: 'DNA structural constraints' },
    ],
  },
  {
    id: 'evolution',
    name: 'Evolutionary',
    icon: <IconGlobe size={16} />,
    level: 'power',
    tools: [
      { id: 'kmerAnomaly', name: 'K-mer Anomaly', shortcut: 'V', description: 'Unusual composition' },
      { id: 'anomaly', name: 'Composite Anomaly', shortcut: 'A', description: 'Multi-metric detection' },
      { id: 'hgt', name: 'HGT Analysis', shortcut: 'Y', description: 'Horizontal gene transfer' },
      { id: 'synteny', name: 'Synteny', description: 'Gene order conservation' },
    ],
  },
  {
    id: 'host',
    name: 'Host Interaction',
    icon: <IconShield size={16} />,
    level: 'power',
    tools: [
      { id: 'tropism', name: 'Tropism & Receptors', shortcut: '0', description: 'Host binding predictions' },
      { id: 'crispr', name: 'CRISPR Spacers', shortcut: 'C', description: 'Spacer matches' },
      { id: 'mosaicRadar', name: 'Mosaic Radar', description: 'Genomic mosaicism' },
    ],
  },
  {
    id: 'simulations',
    name: 'Simulations',
    icon: <IconZap size={16} />,
    tools: [
      { id: 'simulationHub', name: 'Simulation Hub', shortcut: 'S', description: 'All simulations' },
    ],
  },
];

interface AnalysisSidebarProps {
  className?: string;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

export function AnalysisSidebar({
  className = '',
  collapsed = false,
  onToggleCollapse,
}: AnalysisSidebarProps): React.ReactElement {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['sequence', 'genes']) // Default expanded
  );
  const currentPhage = usePhageStore((s) => s.currentPhage);
  const openOverlay = usePhageStore((s) => s.openOverlay);

  const hasPhage = currentPhage !== null;

  const toggleCategory = (categoryId: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(categoryId)) {
        next.delete(categoryId);
      } else {
        next.add(categoryId);
      }
      return next;
    });
  };

  const handleToolClick = (toolId: OverlayId) => {
    openOverlay(toolId);
  };

  if (collapsed) {
    return (
      <aside className={`analysis-sidebar analysis-sidebar--collapsed ${className}`}>
        <button
          type="button"
          className="sidebar-expand-btn"
          onClick={onToggleCollapse}
          title="Expand analysis panel"
          aria-label="Expand analysis panel"
        >
          <IconChevronRight size={20} />
        </button>
        <div className="sidebar-icons">
          {ANALYSIS_CATEGORIES.slice(0, 6).map((cat) => (
            <button
              key={cat.id}
              type="button"
              className="sidebar-icon-btn"
              onClick={() => {
                onToggleCollapse?.();
                setExpandedCategories(new Set([cat.id]));
              }}
              title={cat.name}
              aria-label={cat.name}
            >
              {cat.icon}
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className={`analysis-sidebar ${className}`} aria-label="Analysis tools">
      <div className="sidebar-header">
        <h2 className="sidebar-title">
          <IconBeaker size={18} />
          Analysis Tools
        </h2>
        {onToggleCollapse && (
          <button
            type="button"
            className="sidebar-collapse-btn"
            onClick={onToggleCollapse}
            title="Collapse panel"
            aria-label="Collapse analysis panel"
          >
            <span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}>
              <IconChevronRight size={16} />
            </span>
          </button>
        )}
      </div>

      {!hasPhage && (
        <div className="sidebar-empty">
          <p>Select a phage to access analysis tools</p>
        </div>
      )}

      <div className="sidebar-categories">
        {ANALYSIS_CATEGORIES.map((category) => {
          const isExpanded = expandedCategories.has(category.id);
          return (
            <div key={category.id} className="sidebar-category">
              <button
                type="button"
                className="category-header"
                onClick={() => toggleCategory(category.id)}
                aria-expanded={isExpanded}
                aria-controls={`category-${category.id}`}
              >
                <span className="category-icon">{category.icon}</span>
                <span className="category-name">{category.name}</span>
                {category.level && (
                  <span className={`category-level category-level--${category.level}`}>
                    {category.level === 'power' ? 'Adv' : 'Int'}
                  </span>
                )}
                <span className="category-chevron">
                  {isExpanded ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                </span>
              </button>
              {isExpanded && (
                <ul
                  id={`category-${category.id}`}
                  className="category-tools"
                  role="group"
                  aria-label={`${category.name} tools`}
                >
                  {category.tools.map((tool) => (
                    <li key={tool.id}>
                      <button
                        type="button"
                        className="tool-btn"
                        onClick={() => handleToolClick(tool.id)}
                        disabled={!hasPhage}
                        title={tool.description}
                      >
                        <span className="tool-name">{tool.name}</span>
                        {tool.shortcut && (
                          <kbd className="tool-shortcut">{tool.shortcut}</kbd>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      <div className="sidebar-footer">
        <button
          type="button"
          className="sidebar-help-btn"
          onClick={() => openOverlay('help')}
        >
          All keyboard shortcuts
        </button>
      </div>
    </aside>
  );
}

export default AnalysisSidebar;
