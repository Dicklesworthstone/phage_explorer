/**
 * PhageIllustration - Displays phage anatomy illustration
 *
 * Shows a WebP image of the phage's structural diagram with:
 * - Lazy loading for performance
 * - Click to expand in full-size overlay
 * - Graceful fallback for missing images
 * - Black background to match illustration style
 */

import React, { useState, useCallback } from 'react';
import { useOverlay } from './overlays/OverlayProvider';

interface PhageIllustrationProps {
  /** Phage slug (lowercase) used to find the image */
  slug: string;
  /** Phage display name for alt text */
  name: string;
  /** Optional additional class name */
  className?: string;
  /** Whether to show in compact mode (smaller thumbnail) */
  compact?: boolean;
}

/**
 * Maps phage slug to illustration path.
 * Images are served from /illustrations/{slug}.webp
 */
function getIllustrationPath(slug: string): string {
  return `/illustrations/${slug}.webp`;
}

/**
 * List of phages that have illustrations available.
 * This is used to avoid showing broken images for phages without illustrations.
 */
const AVAILABLE_ILLUSTRATIONS = new Set([
  'd29', 'felixo1', 'l5', 'lambda', 'm13', 'ms2', 'mu', 'n4',
  'p1', 'p2', 'p22', 'phi29', 'phi6', 'phic31', 'phikz', 'phix174',
  'pm2', 'prd1', 'qbeta', 'spbeta', 't1', 't4', 't5', 't7',
]);

export function hasIllustration(slug: string): boolean {
  return AVAILABLE_ILLUSTRATIONS.has(slug.toLowerCase());
}

export function PhageIllustration({
  slug,
  name,
  className = '',
  compact = false,
}: PhageIllustrationProps): React.ReactElement | null {
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const { open, setOverlayData } = useOverlay();

  const normalizedSlug = slug.toLowerCase();
  const imagePath = getIllustrationPath(normalizedSlug);
  const hasImage = hasIllustration(normalizedSlug);

  const handleLoad = useCallback(() => {
    setIsLoaded(true);
  }, []);

  const handleError = useCallback(() => {
    setHasError(true);
  }, []);

  const handleClick = useCallback(() => {
    // Store illustration data for the overlay
    setOverlayData('illustration', { slug: normalizedSlug, name, path: imagePath });
    open('illustration');
  }, [normalizedSlug, name, imagePath, open, setOverlayData]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      handleClick();
    }
  }, [handleClick]);

  // Don't render anything if no illustration available or error loading
  if (!hasImage || hasError) {
    return null;
  }

  const containerStyle: React.CSSProperties = {
    position: 'relative',
    backgroundColor: '#000',
    borderRadius: '8px',
    overflow: 'hidden',
    cursor: 'pointer',
    width: '100%',
    maxWidth: compact ? '200px' : '100%',
    aspectRatio: '1 / 1',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '1px solid var(--color-border-light)',
    transition: 'border-color var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out)',
  };

  const imageStyle: React.CSSProperties = {
    width: '100%',
    height: '100%',
    objectFit: 'contain',
    opacity: isLoaded ? 1 : 0,
    transition: 'opacity var(--duration-normal) var(--ease-out)',
  };

  const loadingStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--color-text-dim)',
    fontSize: '0.85rem',
    pointerEvents: 'none',
  };

  const hintStyle: React.CSSProperties = {
    position: 'absolute',
    bottom: '0.5rem',
    right: '0.5rem',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    color: 'var(--color-text-dim)',
    fontSize: '0.7rem',
    padding: '0.2rem 0.4rem',
    borderRadius: '4px',
    opacity: 0,
    transition: 'opacity var(--duration-fast) var(--ease-out)',
    pointerEvents: 'none',
  };

  return (
    <div
      className={`phage-illustration ${className}`}
      style={containerStyle}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
      aria-busy={!isLoaded}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-primary)';
        e.currentTarget.style.boxShadow = '0 0 12px var(--color-primary-glow)';
        const hint = e.currentTarget.querySelector('.illustration-hint') as HTMLElement;
        if (hint) hint.style.opacity = '1';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'var(--color-border-light)';
        e.currentTarget.style.boxShadow = 'none';
        const hint = e.currentTarget.querySelector('.illustration-hint') as HTMLElement;
        if (hint) hint.style.opacity = '0';
      }}
    >
      {!isLoaded && <div style={loadingStyle}>Loading...</div>}
      <img
        src={imagePath}
        alt={`Anatomical diagram of ${name} showing structural components`}
        style={imageStyle}
        loading="lazy"
        decoding="async"
        onLoad={handleLoad}
        onError={handleError}
      />
      <div className="illustration-hint" style={hintStyle}>
        Click to expand
      </div>
    </div>
  );
}

export default PhageIllustration;
