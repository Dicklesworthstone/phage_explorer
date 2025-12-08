import React from 'react';
import { useWebPreferences } from '../../store/createWebStore';

export const RecentCommands: React.FC = () => {
  const history = useWebPreferences(s => s.commandHistory);

  if (!history.length) {
    return (
      <div className="recent-commands" role="status" aria-live="polite" aria-label="Recent commands">
        <div className="recent-commands__title">Recent commands</div>
        <div className="recent-commands__empty">No commands yet</div>
      </div>
    );
  }

  return (
    <div className="recent-commands" role="log" aria-live="polite" aria-label="Recent commands history">
      <div className="recent-commands__title">Recent commands</div>
      <ul className="recent-commands__list">
        {history.slice(0, 5).map((h, i) => (
          <li key={h.at + i} className="recent-commands__item">
            <span className="dot" />
            <span>{h.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default RecentCommands;
