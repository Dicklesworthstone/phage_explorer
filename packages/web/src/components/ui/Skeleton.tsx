/**
 * Skeleton Component System
 *
 * A unified skeleton loader system for showing loading states with premium animations.
 * Supports pulse and shimmer animations, respects reduced-motion preferences.
 *
 * @see phage_explorer-milk - Create unified Skeleton component system
 */

import React from 'react';
import './skeleton.css';

/* ============================================================================
 * BASE SKELETON COMPONENT
 * ============================================================================ */

export interface SkeletonProps {
  /** Shape variant */
  variant?: 'text' | 'rect' | 'circular';
  /** Width (number = px, string = CSS value) */
  width?: number | string;
  /** Height (number = px, string = CSS value) */
  height?: number | string;
  /** Animation type */
  animation?: 'pulse' | 'shimmer' | 'none';
  /** Additional CSS classes */
  className?: string;
  /** Accessible label */
  'aria-label'?: string;
}

export function Skeleton({
  variant = 'rect',
  width,
  height,
  animation = 'shimmer',
  className = '',
  'aria-label': ariaLabel = 'Loading...',
}: SkeletonProps): React.ReactElement {
  const style: React.CSSProperties = {
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
  };

  // For text variant, default height to 1em if not specified
  if (variant === 'text' && !height) {
    style.height = '1em';
  }

  // For circular, ensure equal dimensions
  if (variant === 'circular') {
    const size = width || height || 40;
    style.width = typeof size === 'number' ? `${size}px` : size;
    style.height = style.width;
  }

  return (
    <div
      className={`skeleton skeleton--${variant} skeleton--${animation} ${className}`}
      style={style}
      role="status"
      aria-label={ariaLabel}
      aria-busy="true"
    />
  );
}

/* ============================================================================
 * COMPOSITE SKELETON COMPONENTS
 * ============================================================================ */

/**
 * Skeleton for sequence view rows
 */
export interface SequenceViewSkeletonProps {
  rows?: number;
  className?: string;
}

export function SequenceViewSkeleton({
  rows = 3,
  className = '',
}: SequenceViewSkeletonProps): React.ReactElement {
  return (
    <div
      className={`skeleton-sequence-view ${className}`}
      aria-busy="true"
      aria-label="Loading sequence data"
    >
      {/* Position indicator */}
      <div className="skeleton-sequence-view__header">
        <Skeleton variant="text" width={120} height={16} />
        <Skeleton variant="text" width={80} height={14} />
      </div>

      {/* Sequence rows */}
      <div className="skeleton-sequence-view__rows">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="skeleton-sequence-view__row">
            {/* Line number */}
            <Skeleton variant="text" width={50} height={18} />
            {/* Sequence content - varying widths for realism */}
            <Skeleton
              variant="rect"
              width={`${85 + (i % 3) * 5}%`}
              height={22}
            />
          </div>
        ))}
      </div>

      {/* Gene map skeleton */}
      <div className="skeleton-sequence-view__gene-map">
        <Skeleton variant="rect" height={24} width="100%" />
      </div>
    </div>
  );
}

/**
 * Skeleton for 3D model viewport
 */
export interface Model3DSkeletonProps {
  className?: string;
}

export function Model3DSkeleton({
  className = '',
}: Model3DSkeletonProps): React.ReactElement {
  return (
    <div
      className={`skeleton-model3d ${className}`}
      aria-busy="true"
      aria-label="Loading 3D model"
    >
      {/* Main viewport placeholder */}
      <div className="skeleton-model3d__viewport">
        <Skeleton variant="rect" width="100%" height="100%" animation="pulse" />
        {/* Center loading indicator */}
        <div className="skeleton-model3d__center">
          <Skeleton variant="circular" width={60} height={60} animation="pulse" />
        </div>
      </div>

      {/* Controls bar skeleton */}
      <div className="skeleton-model3d__controls">
        <Skeleton variant="rect" width={32} height={32} />
        <Skeleton variant="rect" width={32} height={32} />
        <Skeleton variant="rect" width={32} height={32} />
      </div>
    </div>
  );
}

/**
 * Skeleton for phage list items
 */
export interface PhageListItemSkeletonProps {
  count?: number;
  className?: string;
}

export function PhageListItemSkeleton({
  count = 5,
  className = '',
}: PhageListItemSkeletonProps): React.ReactElement {
  return (
    <div
      className={`skeleton-phage-list ${className}`}
      aria-busy="true"
      aria-label="Loading phage list"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton-phage-list__item">
          {/* Avatar/icon */}
          <Skeleton variant="circular" width={40} height={40} />
          {/* Content */}
          <div className="skeleton-phage-list__content">
            <Skeleton variant="text" width={`${60 + (i % 3) * 15}%`} height={16} />
            <Skeleton variant="text" width={`${40 + (i % 2) * 20}%`} height={12} />
          </div>
          {/* Badge */}
          <Skeleton variant="rect" width={48} height={20} />
        </div>
      ))}
    </div>
  );
}

/**
 * Skeleton for gene map annotation bar
 */
export interface GeneMapSkeletonProps {
  className?: string;
}

export function GeneMapSkeleton({
  className = '',
}: GeneMapSkeletonProps): React.ReactElement {
  return (
    <div
      className={`skeleton-gene-map ${className}`}
      aria-busy="true"
      aria-label="Loading gene map"
    >
      {/* Forward strand track */}
      <div className="skeleton-gene-map__track">
        <Skeleton variant="rect" width="15%" height={12} />
        <Skeleton variant="rect" width="8%" height={12} />
        <Skeleton variant="rect" width="22%" height={12} />
        <Skeleton variant="rect" width="12%" height={12} />
        <Skeleton variant="rect" width="18%" height={12} />
      </div>
      {/* Ruler line */}
      <Skeleton variant="rect" width="100%" height={2} animation="none" />
      {/* Reverse strand track */}
      <div className="skeleton-gene-map__track">
        <Skeleton variant="rect" width="10%" height={12} />
        <Skeleton variant="rect" width="25%" height={12} />
        <Skeleton variant="rect" width="6%" height={12} />
        <Skeleton variant="rect" width="20%" height={12} />
      </div>
    </div>
  );
}

/**
 * Skeleton for analysis/overlay panels
 */
export interface AnalysisPanelSkeletonProps {
  className?: string;
}

export function AnalysisPanelSkeleton({
  className = '',
}: AnalysisPanelSkeletonProps): React.ReactElement {
  return (
    <div
      className={`skeleton-analysis-panel ${className}`}
      aria-busy="true"
      aria-label="Loading analysis"
    >
      {/* Header */}
      <div className="skeleton-analysis-panel__header">
        <Skeleton variant="text" width={180} height={20} />
        <Skeleton variant="circular" width={24} height={24} />
      </div>

      {/* Stats row */}
      <div className="skeleton-analysis-panel__stats">
        <div className="skeleton-analysis-panel__stat">
          <Skeleton variant="text" width={60} height={12} />
          <Skeleton variant="text" width={80} height={24} />
        </div>
        <div className="skeleton-analysis-panel__stat">
          <Skeleton variant="text" width={70} height={12} />
          <Skeleton variant="text" width={60} height={24} />
        </div>
        <div className="skeleton-analysis-panel__stat">
          <Skeleton variant="text" width={50} height={12} />
          <Skeleton variant="text" width={90} height={24} />
        </div>
      </div>

      {/* Chart placeholder */}
      <div className="skeleton-analysis-panel__chart">
        <Skeleton variant="rect" width="100%" height={120} animation="pulse" />
      </div>

      {/* Detail rows */}
      <div className="skeleton-analysis-panel__details">
        <Skeleton variant="text" width="90%" height={14} />
        <Skeleton variant="text" width="75%" height={14} />
        <Skeleton variant="text" width="85%" height={14} />
      </div>
    </div>
  );
}

/**
 * Skeleton for search results
 */
export interface SearchResultsSkeletonProps {
  count?: number;
  className?: string;
}

export function SearchResultsSkeleton({
  count = 4,
  className = '',
}: SearchResultsSkeletonProps): React.ReactElement {
  return (
    <div
      className={`skeleton-search-results ${className}`}
      aria-busy="true"
      aria-label="Loading search results"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton-search-results__item">
          <div className="skeleton-search-results__icon">
            <Skeleton variant="rect" width={20} height={20} />
          </div>
          <div className="skeleton-search-results__content">
            <Skeleton variant="text" width={`${50 + (i % 4) * 12}%`} height={16} />
            <Skeleton variant="text" width={`${30 + (i % 3) * 15}%`} height={12} />
          </div>
          <div className="skeleton-search-results__badge">
            <Skeleton variant="rect" width={40} height={18} />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * Skeleton for genome track visualizations
 */
export interface GenomeTrackSkeletonProps {
  height?: number;
  className?: string;
}

export function GenomeTrackSkeleton({
  height = 56,
  className = '',
}: GenomeTrackSkeletonProps): React.ReactElement {
  return (
    <div
      className={`skeleton-genome-track ${className}`}
      aria-busy="true"
      aria-label="Loading genome track"
      style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
    >
      <Skeleton variant="text" width={180} height={14} />
      <Skeleton variant="rect" width="100%" height={height} />
    </div>
  );
}

/**
 * Skeleton for complex analysis overlays (multi-panel with tracks, charts, tables)
 */
export interface ComplexAnalysisSkeletonProps {
  className?: string;
  showTrack?: boolean;
  showHeatmap?: boolean;
  showScatter?: boolean;
  showTable?: boolean;
}

export function ComplexAnalysisSkeleton({
  className = '',
  showTrack = true,
  showHeatmap = true,
  showScatter = true,
  showTable = true,
}: ComplexAnalysisSkeletonProps): React.ReactElement {
  return (
    <div
      className={`skeleton-complex-analysis ${className}`}
      aria-busy="true"
      aria-label="Loading analysis"
      style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
    >
      {/* Description box skeleton */}
      <Skeleton variant="rect" width="100%" height={60} />

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.75rem' }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', alignItems: 'center', padding: '0.75rem' }}>
            <Skeleton variant="text" width={60} height={12} />
            <Skeleton variant="text" width={80} height={24} />
          </div>
        ))}
      </div>

      {/* Genome track skeleton */}
      {showTrack && <GenomeTrackSkeleton />}

      {/* Chart area - heatmap + scatter grid */}
      {(showHeatmap || showScatter) && (
        <div style={{ display: 'grid', gridTemplateColumns: showHeatmap && showScatter ? '2fr 1fr' : '1fr', gap: '1rem' }}>
          {showHeatmap && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <Skeleton variant="text" width={200} height={14} />
              <Skeleton variant="rect" width="100%" height={200} animation="pulse" />
            </div>
          )}
          {showScatter && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <Skeleton variant="text" width={150} height={14} />
              <Skeleton variant="rect" width="100%" height={200} animation="pulse" />
            </div>
          )}
        </div>
      )}

      {/* Table area */}
      {showTable && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <Skeleton variant="text" width={120} height={16} />
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} variant="rect" width="100%" height={36} />
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <Skeleton variant="text" width={100} height={16} />
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} variant="text" width={`${80 - i * 10}%`} height={14} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Skeleton for chart-based overlays (GC Skew, Complexity, Bendability)
 */
export interface ChartOverlaySkeletonProps {
  className?: string;
}

export function ChartOverlaySkeleton({
  className = '',
}: ChartOverlaySkeletonProps): React.ReactElement {
  return (
    <div
      className={`skeleton-chart-overlay ${className}`}
      aria-busy="true"
      aria-label="Loading chart"
      style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
    >
      {/* Description */}
      <Skeleton variant="rect" width="100%" height={50} />

      {/* Stats row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '1rem' }}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem', alignItems: 'center', padding: '0.5rem' }}>
            <Skeleton variant="text" width={50} height={12} />
            <Skeleton variant="text" width={70} height={20} />
          </div>
        ))}
      </div>

      {/* Chart canvas */}
      <Skeleton variant="rect" width="100%" height={200} animation="pulse" />

      {/* Legend */}
      <div style={{ display: 'flex', justifyContent: 'center', gap: '2rem' }}>
        <Skeleton variant="text" width={100} height={14} />
        <Skeleton variant="text" width={80} height={14} />
        <Skeleton variant="text" width={90} height={14} />
      </div>
    </div>
  );
}

/* ============================================================================
 * SKELETON CONTAINER (with delay support)
 * ============================================================================ */

export interface SkeletonContainerProps {
  /** Whether to show the skeleton */
  loading: boolean;
  /** Delay before showing skeleton (ms) - prevents flash for fast loads */
  delay?: number;
  /** The skeleton to show */
  skeleton: React.ReactNode;
  /** The actual content */
  children: React.ReactNode;
  /** Minimum time to show skeleton once visible (ms) */
  minDuration?: number;
}

export function SkeletonContainer({
  loading,
  delay = 200,
  skeleton,
  children,
  minDuration = 300,
}: SkeletonContainerProps): React.ReactElement {
  const [showSkeleton, setShowSkeleton] = React.useState(false);
  const [canHide, setCanHide] = React.useState(true);
  const showTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (loading) {
      // Start delay timer before showing skeleton
      showTimerRef.current = setTimeout(() => {
        setShowSkeleton(true);
        setCanHide(false);
        // Start minimum duration timer
        hideTimerRef.current = setTimeout(() => {
          setCanHide(true);
        }, minDuration);
      }, delay);
    } else {
      // Clear show timer if still pending
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      // Only hide if minimum duration has passed
      if (canHide) {
        setShowSkeleton(false);
      }
    }

    return () => {
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    };
  }, [loading, delay, minDuration, canHide]);

  // Hide skeleton when loading completes and minDuration has passed
  React.useEffect(() => {
    if (!loading && canHide) {
      setShowSkeleton(false);
    }
  }, [loading, canHide]);

  if (showSkeleton && loading) {
    return <>{skeleton}</>;
  }

  return <>{children}</>;
}
