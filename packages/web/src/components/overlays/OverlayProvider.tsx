/**
 * OverlayProvider - Multi-Overlay Stack Management
 *
 * Provides a React context for managing a stack of overlays.
 * Supports focus trapping, z-index management, and keyboard navigation.
 */

import React, { createContext, useContext, useCallback, useEffect, useState, useRef, type ReactNode } from 'react';

// All possible overlay IDs (matching TUI)
export type OverlayId =
  | 'help'
  | 'search'
  | 'goto'
  | 'aaKey'
  | 'comparison'
  | 'analysisMenu'
  | 'simulationHub'
  | 'simulationView'
  | 'complexity'
  | 'gcSkew'
  | 'bendability'
  | 'promoter'
  | 'repeats'
  | 'transcriptionFlow'
  | 'pressure'
  | 'modules'
  | 'hgt'
  | 'kmerAnomaly'
  | 'foldQuickview'
  | 'commandPalette'
  | 'phasePortrait'
  | 'biasDecomposition'
  | 'crispr'
  | 'synteny'
  | 'tropism'
  | 'welcome'
  | 'collaboration';

export interface OverlayConfig {
  id: OverlayId;
  blocking?: boolean; // Prevents interaction with content below
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
}

interface OverlayStackItem {
  id: OverlayId;
  config: OverlayConfig;
  zIndex: number;
}

interface OverlayContextValue {
  // State
  stack: OverlayStackItem[];
  topOverlay: OverlayId | null;
  isOpen: (id: OverlayId) => boolean;
  hasBlockingOverlay: boolean;

  // Actions
  open: (id: OverlayId, config?: Partial<OverlayConfig>) => void;
  close: (id?: OverlayId) => void;
  toggle: (id: OverlayId, config?: Partial<OverlayConfig>) => void;
  closeAll: () => void;

  // Overlay data store (for computed analysis data)
  overlayData: Record<string, unknown>;
  setOverlayData: (key: string, value: unknown) => void;
}

const OverlayContext = createContext<OverlayContextValue | null>(null);

const BASE_Z_INDEX = 100;
const MAX_STACK_SIZE = 3;

const DEFAULT_CONFIG: OverlayConfig = {
  id: 'help',
  blocking: true,
  closeOnEscape: true,
  closeOnBackdrop: true,
};

interface OverlayProviderProps {
  children: ReactNode;
}

export function OverlayProvider({ children }: OverlayProviderProps): React.ReactElement {
  const [stack, setStack] = useState<OverlayStackItem[]>([]);
  const [overlayData, setOverlayDataState] = useState<Record<string, unknown>>({});
  const escapeHandlerRef = useRef<((e: KeyboardEvent) => void) | null>(null);

  // Get the top overlay
  const topOverlay = stack.length > 0 ? stack[stack.length - 1].id : null;

  // Check if any overlay is blocking
  const hasBlockingOverlay = stack.some(item => item.config.blocking);

  // Check if a specific overlay is open
  const isOpen = useCallback((id: OverlayId): boolean => {
    return stack.some(item => item.id === id);
  }, [stack]);

  // Open an overlay
  const open = useCallback((id: OverlayId, config?: Partial<OverlayConfig>) => {
    setStack(currentStack => {
      // Remove if already in stack (will re-add at top)
      const filtered = currentStack.filter(item => item.id !== id);

      // Create new item
      const newItem: OverlayStackItem = {
        id,
        config: { ...DEFAULT_CONFIG, id, ...config },
        zIndex: BASE_Z_INDEX + filtered.length,
      };

      // Add to stack (limit to MAX_STACK_SIZE)
      const newStack = [...filtered, newItem].slice(-MAX_STACK_SIZE);

      // Update z-indices
      return newStack.map((item, index) => ({
        ...item,
        zIndex: BASE_Z_INDEX + index,
      }));
    });
  }, []);

  // Close an overlay (specific or top)
  const close = useCallback((id?: OverlayId) => {
    setStack(currentStack => {
      if (id) {
        // Close specific overlay
        return currentStack.filter(item => item.id !== id);
      } else {
        // Close top overlay
        return currentStack.slice(0, -1);
      }
    });
  }, []);

  // Toggle an overlay
  const toggle = useCallback((id: OverlayId, config?: Partial<OverlayConfig>) => {
    if (isOpen(id)) {
      close(id);
    } else {
      open(id, config);
    }
  }, [isOpen, close, open]);

  // Close all overlays
  const closeAll = useCallback(() => {
    setStack([]);
  }, []);

  // Set overlay data
  const setOverlayData = useCallback((key: string, value: unknown) => {
    setOverlayDataState(prev => ({
      ...prev,
      [key]: value,
    }));
  }, []);

  // Global escape key handler
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && stack.length > 0) {
        const topItem = stack[stack.length - 1];
        if (topItem.config.closeOnEscape) {
          e.preventDefault();
          e.stopPropagation();
          close(topItem.id);
        }
      }
    };

    escapeHandlerRef.current = handleEscape;
    window.addEventListener('keydown', handleEscape);

    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [stack, close]);

  const value: OverlayContextValue = {
    stack,
    topOverlay,
    isOpen,
    hasBlockingOverlay,
    open,
    close,
    toggle,
    closeAll,
    overlayData,
    setOverlayData,
  };

  return (
    <OverlayContext.Provider value={value}>
      {children}
    </OverlayContext.Provider>
  );
}

/**
 * Hook to access overlay context
 */
export function useOverlay(): OverlayContextValue {
  const context = useContext(OverlayContext);
  if (!context) {
    throw new Error('useOverlay must be used within an OverlayProvider');
  }
  return context;
}

/**
 * Hook to check if a specific overlay is at the top of the stack
 */
export function useIsTopOverlay(id: OverlayId): boolean {
  const { topOverlay } = useOverlay();
  return topOverlay === id;
}

/**
 * Hook to get overlay z-index
 */
export function useOverlayZIndex(id: OverlayId): number {
  const { stack } = useOverlay();
  const item = stack.find(s => s.id === id);
  return item?.zIndex ?? BASE_Z_INDEX;
}

export default OverlayProvider;
