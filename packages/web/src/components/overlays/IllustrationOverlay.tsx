/**
 * IllustrationOverlay - Full-size phage anatomy viewer
 *
 * Displays phage structural diagrams in a large, zoomable overlay.
 * Features:
 * - Full-screen black background for optimal viewing
 * - Scroll wheel to zoom, drag to pan
 * - Download button for educational use
 * - Keyboard navigation (+/- to zoom, 0 to reset, Escape to close)
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Overlay } from './Overlay';
import { useOverlay } from './OverlayProvider';
import { IconDownload, IconZoomIn, IconZoomOut, IconRotateCcw } from '../ui';

interface IllustrationData {
  slug: string;
  name: string;
  path: string;
}

export function IllustrationOverlay(): React.ReactElement | null {
  const { overlayData, isOpen } = useOverlay();
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const positionStart = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const illustration = overlayData.illustration as IllustrationData | undefined;
  const illustrationIsOpen = isOpen('illustration');

  // Reset zoom and position when overlay opens
  useEffect(() => {
    if (illustrationIsOpen) {
      setScale(1);
      setPosition({ x: 0, y: 0 });
    }
  }, [illustrationIsOpen]);

  const handleZoomIn = useCallback(() => {
    setScale((s) => Math.min(s * 1.25, 4));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((s) => Math.max(s / 1.25, 0.5));
  }, []);

  const handleReset = useCallback(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
  }, []);

  const handleDownload = useCallback(() => {
    if (!illustration) return;
    const link = document.createElement('a');
    link.href = illustration.path;
    link.download = `${illustration.slug}-anatomy.webp`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [illustration]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (scale <= 1) return;
    setIsDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    positionStart.current = { ...position };
  }, [scale, position]);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setPosition({
      x: positionStart.current.x + dx,
      y: positionStart.current.y + dy,
    });
  }, [isDragging]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  // Wheel handler needs native event listener with passive: false to allow preventDefault
  // Depends on illustration so it re-runs when the overlay content becomes available
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setScale((s) => Math.min(Math.max(s * delta, 0.5), 4));
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => container.removeEventListener('wheel', handleWheel);
  }, [illustration]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    switch (e.key) {
      case '+':
      case '=':
        handleZoomIn();
        break;
      case '-':
        handleZoomOut();
        break;
      case '0':
        handleReset();
        break;
    }
  }, [handleZoomIn, handleZoomOut, handleReset]);

  if (!illustration) {
    return (
      <Overlay id="illustration" title="Phage Anatomy" size="full">
        <div style={{ textAlign: 'center', padding: '2rem', color: 'var(--color-text-dim)' }}>
          No illustration selected
        </div>
      </Overlay>
    );
  }

  return (
    <Overlay
      id="illustration"
      title={`${illustration.name} - Anatomy`}
      size="full"
      className="illustration-overlay"
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: '0.75rem',
        }}
        onKeyDown={handleKeyDown}
        tabIndex={0}
      >
        {/* Toolbar */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            padding: '0 0.5rem',
          }}
        >
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleZoomOut}
              aria-label="Zoom out"
              title="Zoom out (-)"
            >
              <IconZoomOut size={16} />
            </button>
            <span
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0 0.75rem',
                fontSize: '0.85rem',
                color: 'var(--color-text-muted)',
                minWidth: '4rem',
                justifyContent: 'center',
              }}
            >
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleZoomIn}
              aria-label="Zoom in"
              title="Zoom in (+)"
            >
              <IconZoomIn size={16} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={handleReset}
              aria-label="Reset zoom"
              title="Reset (0)"
            >
              <IconRotateCcw size={16} />
            </button>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={handleDownload}
            aria-label="Download illustration"
          >
            <IconDownload size={16} />
            <span style={{ marginLeft: '0.35rem' }}>Download</span>
          </button>
        </div>

        {/* Image container */}
        <div
          ref={containerRef}
          style={{
            flex: 1,
            backgroundColor: '#000',
            borderRadius: '8px',
            overflow: 'hidden',
            position: 'relative',
            cursor: scale > 1 ? (isDragging ? 'grabbing' : 'grab') : 'default',
          }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          <img
            src={illustration.path}
            alt={`Detailed anatomical diagram of ${illustration.name} showing structural components`}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'contain',
              transform: `scale(${scale}) translate(${position.x / scale}px, ${position.y / scale}px)`,
              transition: isDragging ? 'none' : 'transform 0.15s ease-out',
              userSelect: 'none',
              pointerEvents: 'none',
            }}
            draggable={false}
          />
        </div>

        {/* Help text */}
        <div
          style={{
            textAlign: 'center',
            fontSize: '0.75rem',
            color: 'var(--color-text-dim)',
            padding: '0.25rem',
          }}
        >
          Scroll to zoom • Drag to pan when zoomed • Press +/- or 0 to reset
        </div>
      </div>
    </Overlay>
  );
}

export default IllustrationOverlay;
