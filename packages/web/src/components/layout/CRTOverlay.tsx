import React from 'react';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useWebPreferences } from '../../store/createWebStore';

export const CRTOverlay: React.FC = () => {
  const scanlines = useWebPreferences(s => s.scanlines);
  const reducedMotion = useReducedMotion();

  if (!scanlines || reducedMotion) return null;

  return (
    <div className="crt-overlay" aria-hidden="true">
      <div className="scanlines" />
      <div className="vignette" />
      <div className="noise" />
    </div>
  );
};
