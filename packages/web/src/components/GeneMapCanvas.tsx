import React, { useEffect, useRef, useMemo } from 'react';
import { usePhageStore } from '@phage-explorer/state';
import { useTheme } from '../hooks/useTheme';

interface GeneMapCanvasProps {
  height?: number;
  className?: string;
  onGeneClick?: (startPos: number) => void;
}

export function GeneMapCanvas({
  height = 60,
  onGeneClick,
}: GeneMapCanvasProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const colors = theme.colors;

  const currentPhage = usePhageStore((s) => s.currentPhage);
  const scrollPosition = usePhageStore((s) => s.scrollPosition);
  const viewMode = usePhageStore((s) => s.viewMode);

  const genes = useMemo(() => currentPhage?.genes ?? [], [currentPhage]);
  const genomeLength = useMemo(() => currentPhage?.genomeLength ?? 1, [currentPhage]);

  // Handle click to navigate
  const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onGeneClick || !genomeLength) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    
    // Map click X to genome position
    const clickRatio = x / width;
    const targetPos = Math.floor(clickRatio * genomeLength);
    
    onGeneClick(targetPos);
  };

  const [hoveredGene, setHoveredGene] = React.useState<{ name: string; product?: string; x: number; y: number } | null>(null);

  // Handle mouse move for tooltips
  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!currentPhage || !genomeLength) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = rect.width;
    
    // Map X to genome position
    const hoverPos = Math.floor((x / width) * genomeLength);
    
    // Find gene at this position
    const gene = genes.find(g => hoverPos >= g.startPos && hoverPos < g.endPos);
    
    if (gene) {
      setHoveredGene({
        name: gene.name || gene.locusTag || 'Unknown',
        product: gene.product,
        x: e.clientX,
        y: e.clientY - 10 // Shift up slightly
      });
    } else {
      setHoveredGene(null);
    }
  };

  const handleMouseLeave = () => {
    setHoveredGene(null);
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !currentPhage) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Handle high DPI
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const width = rect.width;
    
    // Clear
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, width, height);

    // Track vertical layout
    const trackHeight = 12;
    const forwardY = 10;
    const reverseY = 30;
    const rulerY = 25;

    // Draw background tracks
    ctx.fillStyle = colors.backgroundAlt;
    ctx.fillRect(0, forwardY, width, trackHeight);
    ctx.fillRect(0, reverseY, width, trackHeight);

    // Draw genes
    genes.forEach(gene => {
      const startX = (gene.startPos / genomeLength) * width;
      const endX = (gene.endPos / genomeLength) * width;
      const geneWidth = Math.max(1, endX - startX); // Ensure at least 1px visible

      const isForward = gene.strand !== '-';
      const y = isForward ? forwardY : reverseY;
      
      // Color based on strand
      ctx.fillStyle = isForward 
        ? (colors.geneForward ?? '#22c55e') 
        : (colors.geneReverse ?? '#ef4444');
        
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
    ctx.strokeStyle = colors.borderLight;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, rulerY);
    ctx.lineTo(width, rulerY);
    ctx.stroke();

    // Draw viewport/scroll indicator
    // Assuming SequenceView shows ~100-200 bases depending on screen
    // We'll just draw a single cursor line for now since the viewport is tiny relative to genome
    const effectivePos = viewMode === 'aa' ? scrollPosition * 3 : scrollPosition;
    const cursorX = (effectivePos / genomeLength) * width;

    // Cursor line
    ctx.strokeStyle = colors.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cursorX, 0);
    ctx.lineTo(cursorX, height);
    ctx.stroke();

    // Cursor head
    ctx.fillStyle = colors.accent;
    ctx.beginPath();
    ctx.moveTo(cursorX - 4, 0);
    ctx.lineTo(cursorX + 4, 0);
    ctx.lineTo(cursorX, 6);
    ctx.fill();

  }, [currentPhage, genes, genomeLength, scrollPosition, viewMode, colors, height]);

  return (
    <div className="gene-map-container" style={{ 
      position: 'relative', 
      height, 
      border: `1px solid ${colors.border}`,
      borderRadius: '6px',
      overflow: 'hidden',
      marginBottom: '8px'
    }}>
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: '100%', display: 'block', cursor: 'pointer' }}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
        title="Click to jump to position"
      />
      {hoveredGene && (
        <div style={{
          position: 'fixed',
          left: hoveredGene.x,
          top: hoveredGene.y,
          transform: 'translate(-50%, -100%)',
          backgroundColor: colors.backgroundElevated,
          border: `1px solid ${colors.border}`,
          borderRadius: '4px',
          padding: '4px 8px',
          pointerEvents: 'none',
          zIndex: 1000,
          boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          fontSize: '12px',
          maxWidth: '200px',
        }}>
          <div style={{ fontWeight: 'bold', color: colors.text }}>{hoveredGene.name}</div>
          {hoveredGene.product && (
            <div style={{ color: colors.textDim, fontSize: '10px', marginTop: '2px' }}>
              {hoveredGene.product}
            </div>
          )}
        </div>
      )}
    </div>
  );
}