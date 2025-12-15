/**
 * Matrix Rain Effect
 *
 * Canvas-based digital rain animation.
 * Supports configurable density, speed, and character sets (DNA, Binary, Matrix).
 */

import React, { useRef, useEffect } from 'react';
import { useTheme } from '../hooks/useTheme';
import { useReducedMotion } from '../hooks/useReducedMotion';
import { useWebPreferences } from '../store/createWebStore';

const CHAR_SETS = {
  dna: 'ATGC',
  amino: 'ARNDCQEGHILKMFPSTWYV*',
  binary: '01',
  matrix: 'ﾊﾐﾋﾑﾒﾍﾛﾝ012345789:・.=*+-<>¦｜',
  hex: '0123456789ABCDEF',
};

export interface MatrixRainProps {
  width?: number;
  height?: number;
  opacity?: number;
  className?: string;
  charSet?: keyof typeof CHAR_SETS;
}

export const MatrixRain: React.FC<MatrixRainProps> = ({
  width,
  height,
  opacity = 0.1,
  className = '',
  charSet = 'dna',
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { theme } = useTheme();
  const reducedMotion = useReducedMotion();
  const tuiMode = useWebPreferences(s => s.tuiMode);

  // In a real app, these could be in store or passed as props
  // For now, we default to 'dna' and moderate settings
  const density = 1.0; // 0.5 - 2.0
  const speed = 1.0;   // 0.5 - 3.0

  useEffect(() => {
    if (reducedMotion || tuiMode) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Track visibility for performance
    let isVisible = !document.hidden;
    let isInViewport = true;

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

    let animationId: number | null = null;
    let lastTime = 0;
    const targetFps = 24; // Reduced from 30 for better performance
    const frameInterval = 1000 / targetFps;

    const draw = (time: number) => {
      animationId = null;

      // Skip rendering if tab is hidden or element is offscreen
      if (!isVisible || !isInViewport) {
        return;
      }

      const delta = time - lastTime;

      if (delta >= frameInterval) {
        lastTime = time - (delta % frameInterval);

        // Fade out
        ctx.fillStyle = `rgba(${hexToRgb(colors.background)}, 0.05)`;
        ctx.fillRect(0, 0, w, h);

        ctx.font = `${fontSize}px monospace`;
        const baseAlpha = clamp01(opacity);

        for (let i = 0; i < drops.length; i++) {
          // Skip some columns based on density
          if (i % Math.ceil(2 / density) !== 0) continue;

          const text = chars[Math.floor(Math.random() * chars.length)];

          // Color logic: head is bright, tail is themed
          const isHead = Math.random() > 0.95;
          ctx.fillStyle = isHead ? colors.highlight : colors.primary;

          // Vary opacity
          ctx.globalAlpha = isHead ? Math.min(1, baseAlpha * 1.5) : baseAlpha;

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

    const startAnimation = () => {
      if (animationId === null && isVisible && isInViewport) {
        animationId = requestAnimationFrame(draw);
      }
    };

    const stopAnimation = () => {
      if (animationId !== null) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
    };

    // Start initial animation
    startAnimation();

    const handleResize = () => {
      const dims = resize();
      w = dims.w;
      h = dims.h;
    };

    // Pause when tab is hidden
    const handleVisibility = () => {
      isVisible = !document.hidden;
      if (isVisible) {
        startAnimation();
      } else {
        stopAnimation();
      }
    };

    // Intersection observer for viewport visibility
    let observer: IntersectionObserver | null = null;
    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (entry) {
            isInViewport = entry.isIntersecting;
            if (isInViewport) {
              startAnimation();
            } else {
              stopAnimation();
            }
          }
        },
        { threshold: 0.01 }
      );
      observer.observe(canvas);
    }

    window.addEventListener('resize', handleResize);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      stopAnimation();
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibility);
      observer?.disconnect();
    };
  }, [width, height, theme, density, speed, charSet, opacity, reducedMotion, tuiMode]);

  if (reducedMotion || tuiMode) return null;

  return (
    <canvas
      ref={canvasRef}
      className={`matrix-rain ${className}`}
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export default MatrixRain;
