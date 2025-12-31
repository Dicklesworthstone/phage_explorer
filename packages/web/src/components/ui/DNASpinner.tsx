/**
 * DNASpinner - Branded double-helix loading animation
 *
 * A premium loading spinner featuring an animated DNA double helix,
 * perfect for a bioinformatics application.
 */

import React from 'react';

export type DNASpinnerSize = 'small' | 'medium' | 'large';

export interface DNASpinnerProps {
  /** Visual size variant */
  size?: DNASpinnerSize;
  /** Additional className */
  className?: string;
  /** Accessible label */
  label?: string;
}

/**
 * Get size configuration
 */
function getSizeConfig(size: DNASpinnerSize): {
  width: number;
  height: number;
  nucleotideSize: number;
  bondWidth: number;
} {
  switch (size) {
    case 'small':
      return { width: 24, height: 32, nucleotideSize: 4, bondWidth: 1 };
    case 'large':
      return { width: 48, height: 64, nucleotideSize: 8, bondWidth: 2 };
    default:
      return { width: 36, height: 48, nucleotideSize: 6, bondWidth: 1.5 };
  }
}

/**
 * DNA double helix spinner with rotating nucleotide pairs
 */
export function DNASpinner({
  size = 'medium',
  className,
  label = 'Loading...',
}: DNASpinnerProps): React.ReactElement {
  const config = getSizeConfig(size);
  const classes = ['dna-spinner', `dna-spinner--${size}`, className].filter(Boolean).join(' ');

  // Generate 6 nucleotide pairs for the helix
  const pairs = [0, 1, 2, 3, 4, 5];

  return (
    <div
      className={classes}
      role="status"
      aria-label={label}
      style={{
        width: config.width,
        height: config.height,
      }}
    >
      <svg
        viewBox="0 0 36 48"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="dna-spinner__svg"
      >
        {pairs.map((i) => (
          <g
            key={i}
            className="dna-spinner__pair"
            style={{
              animationDelay: `${i * 100}ms`,
            }}
          >
            {/* Left nucleotide */}
            <circle
              cx="6"
              cy={8 + i * 6}
              r="3"
              className="dna-spinner__nucleotide dna-spinner__nucleotide--left"
            />
            {/* Bond (connecting line) */}
            <line
              x1="9"
              y1={8 + i * 6}
              x2="27"
              y2={8 + i * 6}
              className="dna-spinner__bond"
              strokeWidth="1.5"
            />
            {/* Right nucleotide */}
            <circle
              cx="30"
              cy={8 + i * 6}
              r="3"
              className="dna-spinner__nucleotide dna-spinner__nucleotide--right"
            />
          </g>
        ))}
      </svg>
      <span className="sr-only">{label}</span>
    </div>
  );
}

export default DNASpinner;
