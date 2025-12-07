/**
 * MatrixRain - DNA/Amino Acid Character Rain Effect
 *
 * Decorative background animation inspired by The Matrix,
 * using DNA nucleotides and amino acid characters.
 */

import React, { useRef, useEffect, useCallback } from 'react';
import { useTheme } from '../hooks/useTheme';

interface MatrixRainProps {
  /** Enable or disable the animation */
  enabled?: boolean;
  /** Character density (0.0 - 1.0) */
  density?: number;
  /** Fall speed multiplier */
  speed?: number;
  /** Whether to show DNA or amino acids */
  mode?: 'dna' | 'amino' | 'mixed';
  /** Opacity of the effect (0.0 - 1.0) */
  opacity?: number;
}

const DNA_CHARS = 'ACGT';
const AMINO_CHARS = 'ARNDCQEGHILKMFPSTWYV*';
const MIXED_CHARS = DNA_CHARS + AMINO_CHARS;

interface Drop {
  x: number;
  y: number;
  speed: number;
  chars: string[];
  brightness: number;
  length: number;
}

export function MatrixRain({
  enabled = true,
  density = 0.03,
  speed = 1,
  mode = 'mixed',
  opacity = 0.15,
}: MatrixRainProps): React.ReactElement | null {
  const { theme } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>();
  const dropsRef = useRef<Drop[]>([]);

  const getChars = useCallback(() => {
    switch (mode) {
      case 'dna': return DNA_CHARS;
      case 'amino': return AMINO_CHARS;
      default: return MIXED_CHARS;
    }
  }, [mode]);

  const getRandomChar = useCallback(() => {
    const chars = getChars();
    return chars[Math.floor(Math.random() * chars.length)];
  }, [getChars]);

  const createDrop = useCallback((x: number, startY = -50): Drop => {
    const length = 5 + Math.floor(Math.random() * 15);
    return {
      x,
      y: startY,
      speed: (0.5 + Math.random() * 1.5) * speed,
      chars: Array.from({ length }, () => getRandomChar()),
      brightness: 0.3 + Math.random() * 0.7,
      length,
    };
  }, [speed, getRandomChar]);

  useEffect(() => {
    if (!enabled) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      canvas.width = rect.width * dpr;
      canvas.height = rect.height * dpr;
      ctx.scale(dpr, dpr);

      // Reinitialize drops on resize
      const columns = Math.floor(rect.width / 20);
      dropsRef.current = Array.from({ length: columns }, (_, i) =>
        createDrop(i * 20 + 10, Math.random() * -rect.height)
      );
    };

    resize();
    window.addEventListener('resize', resize);

    const fontSize = 14;
    const charHeight = fontSize * 1.2;
    const primaryColor = theme.colors.primary;

    const animate = () => {
      const rect = canvas.getBoundingClientRect();

      // Clear with fade effect
      ctx.fillStyle = `rgba(${parseInt(theme.colors.background.slice(1, 3), 16)}, ${parseInt(theme.colors.background.slice(3, 5), 16)}, ${parseInt(theme.colors.background.slice(5, 7), 16)}, 0.1)`;
      ctx.fillRect(0, 0, rect.width, rect.height);

      ctx.font = `${fontSize}px monospace`;
      ctx.textAlign = 'center';

      dropsRef.current.forEach((drop, idx) => {
        // Draw each character in the trail
        drop.chars.forEach((char, i) => {
          const y = drop.y - i * charHeight;
          if (y < 0 || y > rect.height) return;

          // Fade out towards the tail
          const fadeRatio = 1 - i / drop.length;
          const alpha = fadeRatio * drop.brightness * opacity;

          if (i === 0) {
            // Head of the drop is brightest (white/bright color)
            ctx.fillStyle = `rgba(255, 255, 255, ${Math.min(1, alpha * 2)})`;
          } else {
            // Parse primary color
            let r = 0, g = 255, b = 0;
            if (primaryColor.startsWith('#')) {
              r = parseInt(primaryColor.slice(1, 3), 16);
              g = parseInt(primaryColor.slice(3, 5), 16);
              b = parseInt(primaryColor.slice(5, 7), 16);
            }
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`;
          }

          ctx.fillText(char, drop.x, y);
        });

        // Move drop down
        drop.y += drop.speed * 2;

        // Randomly change a character
        if (Math.random() < 0.05) {
          const changeIdx = Math.floor(Math.random() * drop.chars.length);
          drop.chars[changeIdx] = getRandomChar();
        }

        // Reset drop if it goes off screen
        if (drop.y - drop.length * charHeight > rect.height) {
          // Check density
          if (Math.random() < density) {
            dropsRef.current[idx] = createDrop(drop.x);
          } else {
            drop.y = -drop.length * charHeight;
          }
        }
      });

      animationRef.current = requestAnimationFrame(animate);
    };

    animate();

    return () => {
      window.removeEventListener('resize', resize);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [enabled, density, speed, opacity, theme, createDrop, getRandomChar]);

  if (!enabled) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        zIndex: -1,
      }}
    />
  );
}

export default MatrixRain;
