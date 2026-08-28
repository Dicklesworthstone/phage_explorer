/**
 * AnalysisSidebar Component
 *
 * A persistent sidebar for large screens that surfaces the 25+ hidden analysis tools
 * organized by category. Previously these were only accessible via keyboard shortcuts.
 */

import React, { useState } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { useOverlay, type OverlayId } from './overlays/OverlayProvider';
import {
  ANALYSIS_SIDEBAR_CATEGORIES,
  detectShortcutPlatform,
  formatPrimaryActionShortcut,
  getActionFromRegistry,
} from '../keyboard/actionSurfaces';
import type { ActionId } from '../keyboard/actionRegistry';
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
} from './ui/icons';

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  sequence: <IconDna size={16} />,
  genes: <IconFlask size={16} />,
  codon: <IconChartBar size={16} />,
  structural: <IconCpu size={16} />,
  evolution: <IconGlobe size={16} />,
  host: <IconShield size={16} />,
  simulations: <IconZap size={16} />,
};

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
  const { open: openOverlay, toggle: toggleOverlay } = useOverlay();
  const shortcutPlatform = detectShortcutPlatform();

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

  const handleToolClick = (toolActionId: ActionId) => {
    const action = getActionFromRegistry(toolActionId);
    if (!action?.overlayId) return;

    const overlayId = action.overlayId as OverlayId;
    if (action.overlayAction === 'open') {
      openOverlay(overlayId);
      return;
    }

    toggleOverlay(overlayId);
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
          {ANALYSIS_SIDEBAR_CATEGORIES.slice(0, 6).map((cat) => (
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
              {CATEGORY_ICON[cat.id]}
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside className={`analysis-sidebar ${className}`} aria-label="Analysis tools" data-testid="analysis-sidebar">
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
        {ANALYSIS_SIDEBAR_CATEGORIES.map((category) => {
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
                <span className="category-icon">{CATEGORY_ICON[category.id]}</span>
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
                  {category.tools.map((tool) => {
                    const action = getActionFromRegistry(tool.actionId);
                    if (!action) return null;

                    const shortcut = formatPrimaryActionShortcut(action, shortcutPlatform);

                    return (
                      <li key={tool.actionId}>
                        <button
                          type="button"
                          className="tool-btn"
                          onClick={() => handleToolClick(tool.actionId)}
                          disabled={!hasPhage}
                          title={tool.description}
                          data-testid={`analysis-tool-${tool.actionId}`}
                        >
                          <span className="tool-name">{action.title}</span>
                          {shortcut && <kbd className="tool-shortcut">{shortcut}</kbd>}
                        </button>
                      </li>
                    );
                  })}
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
