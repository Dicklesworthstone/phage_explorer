/**
 * Matrix Rain Effect
 *
 * Canvas-based digital rain animation.
 * Supports configurable density, speed, and character sets (DNA, Binary, Matrix).
 */

import React, { useRef, useEffect } from 'react';
import { useTheme } from '../hooks/useTheme';
import { useWebPreferences } from '../store/createWebStore';
import { useReducedMotion } from '../hooks/useReducedMotion';

export interface MatrixRainProps {
  width?: number;
  height?: number;
  opacity?: number;
  className?: string;
}

const CHAR_SETS = {
  dna: 'ATGC',
  binary: '01',
  matrix: 'ﾊﾐﾋﾑﾒﾍﾛﾝ012345789:・.=*+-<>¦｜',
  hex: '0123456789ABCDEF',
};

export const MatrixRain: React.FC<MatrixRainProps> = ({
  width,
  height,
  opacity = 0.1,
  className = '',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const reducedMotion = useReducedMotion();
  
  // In a real app, these could be in store or passed as props
  // For now, we default to 'dna' and moderate settings
  const density = 1.0; // 0.5 - 2.0
  const speed = 1.0;   // 0.5 - 3.0
  const charSet = 'dna';

  useEffect(() => {
    if (reducedMotion) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Resize handler
    const resize = () => {
      const w = width || window.innerWidth;
      const h = height || window.innerHeight;
      canvas.width = w;
      canvas.height = h;
      return { w, h };
    };

    let { w, h } = resize();
    
    // Initialize columns
    const fontSize = 14;
    const columns = Math.ceil(w / fontSize);
    const drops: number[] = [];
    
    // Random start positions
    for (let i = 0; i < columns; i++) {
      drops[i] = Math.random() * -(h / fontSize);
    }

    const chars = CHAR_SETS[charSet as keyof typeof CHAR_SETS] || CHAR_SETS.dna;
    const colors = theme.colors;

    let animationId: number;
    let lastTime = 0;
    const targetFps = 30;
    const frameInterval = 1000 / targetFps;

    const draw = (time: number) => {
      const delta = time - lastTime;
      
      if (delta >= frameInterval) {
        lastTime = time - (delta % frameInterval);

        // Fade out
        ctx.fillStyle = `rgba(${hexToRgb(colors.background)}, 0.05)`;
        ctx.fillRect(0, 0, w, h);

        ctx.font = `${fontSize}px monospace`;
        
        for (let i = 0; i < drops.length; i++) {
          // Skip some columns based on density
          if (i % Math.ceil(2 / density) !== 0) continue;

          const text = chars[Math.floor(Math.random() * chars.length)];
          
          // Color logic: head is bright, tail is themed
          const isHead = Math.random() > 0.95;
          ctx.fillStyle = isHead ? colors.highlight : colors.primary;
          
          // Vary opacity
          ctx.globalAlpha = isHead ? opacity * 1.5 : opacity;

          const x = i * fontSize;
          const y = drops[i] * fontSize;

          ctx.fillText(text, x, y);

          // Reset drop or move down
          if (y > h && Math.random() > 0.975) {
            drops[i] = 0;
          }
          
          drops[i] += speed;
        }
        ctx.globalAlpha = 1.0;
      }

      animationId = requestAnimationFrame(draw);
    };

    animationId = requestAnimationFrame(draw);

    const handleResize = () => {
      const dims = resize();
      w = dims.w;
      h = dims.h;
      // Re-init drops if needed, or just let them fall
    };

    window.addEventListener('resize', handleResize);

    return () => {
      cancelAnimationFrame(animationId);
      window.removeEventListener('resize', handleResize);
    };
  }, [width, height, theme, density, speed, charSet, opacity, reducedMotion]);

  if (reducedMotion) return null;

  return (
    <canvas
      ref={canvasRef}
      className={`matrix-rain pointer-events-none fixed inset-0 z-0 ${className}`}
      style={{ opacity }}
      aria-hidden="true"
      role="presentation"
    />
  );
};

// Helper
function hexToRgb(hex: string): string {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}`
    : '0, 0, 0';
}

export default MatrixRain;
