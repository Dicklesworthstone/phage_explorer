import React, { memo, useEffect, useRef, useMemo, useId } from 'react';
import type { GeneInfo } from '@phage-explorer/core';
import { usePhageStore } from '@phage-explorer/state';
import { useTheme } from '../hooks/useTheme';

// Screen reader only styles
const srOnly: React.CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

interface GeneMapCanvasProps {
  height?: number;
  className?: string;
  onGeneClick?: (startPos: number) => void;
  onGeneSelect?: (gene: GeneInfo | null) => void;
}

function GeneMapCanvasBase({
  height = 60,
  className,
  onGeneClick,
  onGeneSelect,
}: GeneMapCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const colors = theme.colors;
  const tooltipId = useId();
  const descriptionId = useId();

  const currentPhage = usePhageStore((s) => s.currentPhage);
  const scrollPosition = usePhageStore((s) => s.scrollPosition);
  const viewMode = usePhageStore((s) => s.viewMode);

  const genes = useMemo(() => currentPhage?.genes ?? [], [currentPhage]);
  const genomeLength = useMemo(() => currentPhage?.genomeLength ?? 1, [currentPhage]);

  // Generate screen reader description of gene content
  const geneDescription = useMemo(() => {
    if (!currentPhage || genes.length === 0) {
      return 'No phage genome loaded.';
    }
    const forwardGenes = genes.filter(g => g.strand !== '-');
    const reverseGenes = genes.filter(g => g.strand === '-');
    return `Gene map showing ${genes.length} genes for ${currentPhage.name}: ` +
      `${forwardGenes.length} on the forward strand, ${reverseGenes.length} on the reverse strand. ` +
      `Genome length: ${genomeLength.toLocaleString()} base pairs. ` +
      `Click or tap to navigate to a gene position.`;
  }, [currentPhage, genes, genomeLength]);

  const [hoveredGene, setHoveredGene] = React.useState<{
    name: string;
    product?: string;
    x: number;
    y: number;
  } | null>(null);

  const lastTouchEndRef = useRef<number>(0);
  const longPressTimerRef = useRef<number | null>(null);
  const tooltipDismissTimerRef = useRef<number | null>(null);
  const touchSessionRef = useRef<{
    startClientX: number;
    startClientY: number;
    moved: boolean;
    longPressed: boolean;
    posBase: number;
    gene: GeneInfo | null;
  } | null>(null);

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current != null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const clearTooltipDismissTimer = () => {
    if (tooltipDismissTimerRef.current != null) {
      window.clearTimeout(tooltipDismissTimerRef.current);
      tooltipDismissTimerRef.current = null;
    }
  };

  // RAF-based throttle for canvas redraws (60fps max)
  const rafIdRef = useRef<number | null>(null);
  const drawPendingRef = useRef(false);

  useEffect(() => {
    return () => {
      clearLongPressTimer();
      clearTooltipDismissTimer();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, []);

  const toScrollUnits = (posBase: number) => {
    if (viewMode === 'aa') return Math.floor(posBase / 3);
    return posBase;
  };

  const getHitInfo = (clientX: number, clientY: number): { posBase: number; gene: GeneInfo | null; clientX: number; clientY: number } | undefined => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const heightPx = rect.height;
    const width = rect.width;
    if (width <= 0 || heightPx <= 0) return;
    if (x < 0 || x > width) return;
    if (y < 0 || y > heightPx) return;

    const posBase = Math.min(
      genomeLength - 1,
      Math.max(0, Math.floor((x / width) * genomeLength))
    );

    const trackHeight = 12;
    const forwardY = 10;
    const reverseY = 30;

    const inForward = y >= forwardY && y <= forwardY + trackHeight;
    const inReverse = y >= reverseY && y <= reverseY + trackHeight;

    let bestGene: GeneInfo | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    if (inForward || inReverse) {
      for (const gene of genes) {
        const isForwardGene = gene.strand !== '-';
        if (inForward && !isForwardGene) continue;
        if (inReverse && isForwardGene) continue;

        const startX = (gene.startPos / genomeLength) * width;
        const endX = (gene.endPos / genomeLength) * width;
        const geneWidth = Math.max(1, endX - startX);
        const hitWidth = Math.max(geneWidth, 44);
        const centerX = startX + geneWidth / 2;
        const hitStart = centerX - hitWidth / 2;
        const hitEnd = centerX + hitWidth / 2;

        if (x < hitStart || x > hitEnd) continue;
        const distance = Math.abs(x - centerX);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestGene = gene;
        }
      }
    }

    return { posBase, gene: bestGene, clientX, clientY };
  };

  const showTooltip = (gene: GeneInfo, clientX: number, clientY: number) => {
    setHoveredGene({
      name: gene.name || gene.locusTag || 'Unknown',
      product: gene.product ?? undefined,
      x: clientX,
      y: clientY,
    });
  };

  const scheduleTooltipDismiss = (ms: number) => {
    clearTooltipDismissTimer();
    tooltipDismissTimerRef.current = window.setTimeout(() => setHoveredGene(null), ms);
  };

  // Handle click to navigate (mouse); touch taps handled separately.
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!genomeLength) return;
    if (performance.now() - lastTouchEndRef.current < 500) return;

    const hit = getHitInfo(e.clientX, e.clientY);
    if (!hit) return;

    const targetBase = hit.gene ? hit.gene.startPos : hit.posBase;
    onGeneSelect?.(hit.gene ?? null);
    onGeneClick?.(toScrollUnits(targetBase));
  };

  // Handle mouse move for tooltips
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!currentPhage || !genomeLength) return;
    const hit = getHitInfo(e.clientX, e.clientY);
    if (!hit || !hit.gene) {
      setHoveredGene(null);
      return;
    }

    showTooltip(hit.gene, hit.clientX, hit.clientY - 10);
  };

  const handleMouseLeave = () => setHoveredGene(null);

  // Touch handling for mobile
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length !== 1) return;
    if (!currentPhage || !genomeLength) return;

    const touch = e.touches[0];
    const hit = getHitInfo(touch.clientX, touch.clientY);
    if (!hit) return;

    clearLongPressTimer();
    clearTooltipDismissTimer();

    touchSessionRef.current = {
      startClientX: touch.clientX,
      startClientY: touch.clientY,
      moved: false,
      longPressed: false,
      posBase: hit.posBase,
      gene: hit.gene,
    };

    const LONG_PRESS_MS = 300;
    if (hit.gene) {
      longPressTimerRef.current = window.setTimeout(() => {
        const session = touchSessionRef.current;
        if (!session || session.moved || !hit.gene) return;
        session.longPressed = true;
        showTooltip(hit.gene, hit.clientX, hit.clientY - 40);
        onGeneSelect?.(hit.gene);
      }, LONG_PRESS_MS);
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length !== 1) return;
    const session = touchSessionRef.current;
    if (!session) return;

    const touch = e.touches[0];
    const dx = touch.clientX - session.startClientX;
    const dy = touch.clientY - session.startClientY;
    const moved = Math.hypot(dx, dy);

    const MOVE_CANCEL_PX = 10;
    if (moved > MOVE_CANCEL_PX) {
      session.moved = true;
      clearLongPressTimer();
      if (!session.longPressed) {
        setHoveredGene(null);
      }
    }

    if (session.longPressed && session.gene) {
      showTooltip(session.gene, touch.clientX, touch.clientY - 40);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLCanvasElement>) => {
    lastTouchEndRef.current = performance.now();
    clearLongPressTimer();

    const session = touchSessionRef.current;
    touchSessionRef.current = null;
    if (!session) return;

    if (session.longPressed) {
      // Keep tooltip briefly after long-press so users can read it.
      scheduleTooltipDismiss(2000);
      return;
    }

    if (session.moved) {
      setHoveredGene(null);
      return;
    }

    // Tap: navigate (if enabled); also show a brief tooltip flash for discovery.
    if (!genomeLength) return;
    if (e.changedTouches.length !== 1) return;

    const touch = e.changedTouches[0];
    const hit = getHitInfo(touch.clientX, touch.clientY);
    if (!hit) return;

    const targetBase = hit.gene ? hit.gene.startPos : hit.posBase;
    onGeneSelect?.(hit.gene ?? null);
    onGeneClick?.(toScrollUnits(targetBase));

    if (hit.gene) {
      showTooltip(hit.gene, hit.clientX, hit.clientY - 40);
      scheduleTooltipDismiss(900);
    } else {
      setHoveredGene(null);
    }
  };

  const handleTouchCancel = () => {
    clearLongPressTimer();
    touchSessionRef.current = null;
    setHoveredGene(null);
  };

  // Store latest values in refs for the RAF callback to use
  const scrollPositionRef = useRef(scrollPosition);
  const colorsRef = useRef(colors);
  const genesRef = useRef(genes);
  const genomeLengthRef = useRef(genomeLength);
  const viewModeRef = useRef(viewMode);
  const heightRef = useRef(height);
  const currentPhageRef = useRef(currentPhage);

  // Keep refs in sync
  useEffect(() => { scrollPositionRef.current = scrollPosition; }, [scrollPosition]);
  useEffect(() => { colorsRef.current = colors; }, [colors]);
  useEffect(() => { genesRef.current = genes; }, [genes]);
  useEffect(() => { genomeLengthRef.current = genomeLength; }, [genomeLength]);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);
  useEffect(() => { heightRef.current = height; }, [height]);
  useEffect(() => { currentPhageRef.current = currentPhage; }, [currentPhage]);

  // Actual draw function - reads from refs to use latest values
  const drawCanvas = React.useCallback(() => {
    const canvas = canvasRef.current;
    const phage = currentPhageRef.current;
    if (!canvas || !phage) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const h = heightRef.current;
    const c = colorsRef.current;
    const g = genesRef.current;
    const gl = genomeLengthRef.current;
    const sp = scrollPositionRef.current;
    const vm = viewModeRef.current;

    // Handle high DPI
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;

    // Clear
    ctx.fillStyle = c.background;
    ctx.fillRect(0, 0, width, h);

    // Track vertical layout
    const trackHeight = 12;
    const forwardY = 10;
    const reverseY = 30;
    const rulerY = 25;

    // Draw background tracks
    ctx.fillStyle = c.backgroundAlt;
    ctx.fillRect(0, forwardY, width, trackHeight);
    ctx.fillRect(0, reverseY, width, trackHeight);

    // Draw genes
    g.forEach(gene => {
      const startX = (gene.startPos / gl) * width;
      const endX = (gene.endPos / gl) * width;
      const geneWidth = Math.max(1, endX - startX); // Ensure at least 1px visible

      const isForward = gene.strand !== '-';
      const y = isForward ? forwardY : reverseY;

      // Color based on strand
      ctx.fillStyle = isForward
        ? (c.geneForward ?? '#22c55e')
        : (c.geneReverse ?? '#ef4444');

      ctx.fillRect(startX, y, geneWidth, trackHeight);

      // Draw gene name if width permits (basic LOD)
      if (geneWidth > 40 && gene.name) {
        ctx.fillStyle = '#ffffff';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(gene.name, startX + geneWidth / 2, y + trackHeight / 2);
      }
    });

    // Draw ruler line
    ctx.strokeStyle = c.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rulerY);
    ctx.lineTo(width, rulerY);
    ctx.stroke();

    // Draw viewport/scroll indicator
    // Assuming SequenceView shows ~100-200 bases depending on screen
    // We'll just draw a single cursor line for now since the viewport is tiny relative to genome
    const effectivePos = vm === 'aa' ? sp * 3 : sp;
    const cursorX = (effectivePos / gl) * width;

    // Cursor line
    ctx.strokeStyle = c.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cursorX, 0);
    ctx.lineTo(cursorX, h);
    ctx.stroke();

    // Cursor head
    ctx.fillStyle = c.accent;
    ctx.beginPath();
    ctx.moveTo(cursorX - 4, 0);
    ctx.lineTo(cursorX + 4, 0);
    ctx.lineTo(cursorX, 6);
    ctx.fill();
  }, []);

  // Schedule a redraw via RAF (throttles to 60fps)
  useEffect(() => {
    // Mark that a redraw is needed
    drawPendingRef.current = true;

    // If no RAF is scheduled, schedule one
    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        if (drawPendingRef.current) {
          drawPendingRef.current = false;
          drawCanvas();
        }
      });
    }
  }, [currentPhage, genes, genomeLength, scrollPosition, viewMode, colors, height, drawCanvas]);

  return (
    <div
      className={`gene-map-container${className ? ` ${className}` : ''}`}
      role="figure"
      aria-label={`Gene map visualization${currentPhage ? ` for ${currentPhage.name}` : ''}`}
      aria-describedby={descriptionId}
      style={{
        position: 'relative',
        height,
        border: `1px solid ${colors.border}`,
        borderRadius: '6px',
        overflow: 'hidden',
        marginBottom: '8px'
      }}
    >
      {/* Screen reader description of the gene map */}
      <div id={descriptionId} style={srOnly}>
        {geneDescription}
      </div>

      {/* Screen reader live region for gene tooltip announcements */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        style={srOnly}
      >
        {hoveredGene
          ? `Gene: ${hoveredGene.name}${hoveredGene.product ? `. Product: ${hoveredGene.product}` : ''}`
          : ''}
      </div>

      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', cursor: 'pointer', touchAction: 'pan-y' }}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
        aria-hidden="true"
        title="Click to jump to position"
      />
      {hoveredGene && (
        (() => {
          const vv = typeof window !== 'undefined' ? window.visualViewport : null;
          const viewportWidth = vv?.width ?? (typeof window !== 'undefined' ? window.innerWidth : 0);
          const viewportHeight = vv?.height ?? (typeof window !== 'undefined' ? window.innerHeight : 0);
          const viewportLeft = vv?.offsetLeft ?? 0;
          const viewportTop = vv?.offsetTop ?? 0;
          const leftMin = viewportLeft + 12;
          const leftMax = viewportLeft + viewportWidth - 12;
          const topMin = viewportTop + 12;
          const topMax = viewportTop + viewportHeight - 12;
          const safeLeftMax = Math.max(leftMin, leftMax);
          const safeTopMax = Math.max(topMin, topMax);
          const clampedLeft = Math.min(Math.max(hoveredGene.x, leftMin), safeLeftMax);
          const clampedTop = Math.min(Math.max(hoveredGene.y, topMin), safeTopMax);
          return (
        <div
          id={tooltipId}
          role="tooltip"
          aria-hidden="false"
          style={{
            position: 'fixed',
            left: typeof window === 'undefined' ? hoveredGene.x : clampedLeft,
            top: typeof window === 'undefined' ? hoveredGene.y : clampedTop,
            transform: clampedTop < topMin + 48 ? 'translate(-50%, 14px)' : 'translate(-50%, -100%)',
            backgroundColor: colors.backgroundAlt,
            border: `1px solid ${colors.border}`,
            borderRadius: '4px',
            padding: '4px 8px',
            pointerEvents: 'none',
            zIndex: 1000,
            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
            fontSize: '12px',
            maxWidth: 'min(240px, calc(100vw - env(safe-area-inset-left) - env(safe-area-inset-right) - 24px))',
          }}
        >
          <div style={{ fontWeight: 'bold', color: colors.text }}>{hoveredGene.name}</div>
          {hoveredGene.product && (
            <div style={{ color: colors.textDim, fontSize: '10px', marginTop: '2px' }}>
              {hoveredGene.product}
            </div>
          )}
        </div>
          );
        })()
      )}
    </div>
  );
}

// Memoize to prevent re-renders when parent updates but props haven't changed
export const GeneMapCanvas = memo(GeneMapCanvasBase);
