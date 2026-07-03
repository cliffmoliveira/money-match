import React, { useEffect, useState } from 'react';
import './Countdown.css';
import { parseTournamentDate } from '../utils/tournamentDate';

// Self-contained, second-ticking countdown to an event timestamp. Owns its
// own interval so only it re-renders each second (not its parent list). Pass
// `compact` for a smaller, left-aligned variant (e.g. Home "Next Up" cards).
//
// `date` is whatever's in tournaments.date — ideally a full ISO timestamp
// with the real start.gg start hour, but older rows not yet re-synced may
// still be a bare "YYYY-MM-DD" — see parseTournamentDate for why those two
// cases need different parsing.
const Countdown = ({ date, compact = false }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const target = parseTournamentDate(date)?.getTime();
  if (isNaN(target)) return null;
  const diff = target - now;
  if (diff <= 0) return <div className={`countdown-live${compact ? ' compact' : ''}`}>Happening now</div>;

  const total = Math.floor(diff / 1000);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const seg = (value, label) => (
    <div className="countdown-seg" key={label}>
      <span className="countdown-num">{String(value).padStart(2, '0')}</span>
      <span className="countdown-label">{label}</span>
    </div>
  );

  return (
    <div className={`countdown${compact ? ' compact' : ''}`}>
      <div className="countdown-title">Starts in</div>
      <div className="countdown-segs">
        {seg(days, 'Days')}
        <span className="countdown-sep">:</span>
        {seg(hours, 'Hrs')}
        <span className="countdown-sep">:</span>
        {seg(minutes, 'Min')}
        <span className="countdown-sep">:</span>
        {seg(seconds, 'Sec')}
      </div>
    </div>
  );
};

export default Countdown;
