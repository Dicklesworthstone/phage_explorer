import React from 'react';
import { Tooltip } from './ui/Tooltip';
import { useBeginnerMode } from '../education/hooks/useBeginnerMode';

const BEGINNER_TOOLTIP = (
  <>
    Beginner Mode is on.
    <br />
    Click to open the glossary. Manage in Settings.
  </>
);

export const BeginnerModeIndicator: React.FC = () => {
  const { isEnabled, openGlossary } = useBeginnerMode();

  if (!isEnabled) return null;

  return (
    <Tooltip content={BEGINNER_TOOLTIP} position="top" className="beginner-indicator__tooltip">
      <div className="beginner-indicator" role="status" aria-live="polite">
        <button
          type="button"
          className="beginner-indicator__button"
          onClick={openGlossary}
          aria-label="Open glossary"
        >
          <span className="beginner-indicator__dot" aria-hidden />
          <span className="beginner-indicator__text">Beginner Mode</span>
        </button>
      </div>
    </Tooltip>
  );
};

export default BeginnerModeIndicator;
