import React from 'react';
import './StakeStepper.css';

// Reusable stake control: big, tappable −/+ buttons around a typeable input.
// Replaces the cramped native number-input spinner in the bet slips.
// `onChange` receives the new value as a STRING (parents clean/parse it).
const StakeStepper = ({ value, onChange, min = 0, step = 10, ariaLabel = 'Stake' }) => {
  const num = Number(value) || 0;
  const setVal = (n) => onChange(String(Math.max(min, Math.round(n * 100) / 100)));
  return (
    <div className="stake-stepper">
      <button
        type="button"
        className="stake-step"
        aria-label="Decrease stake"
        onClick={() => setVal(num - step)}
        disabled={num <= min}
      >
        −
      </button>
      <input
        type="number"
        inputMode="numeric"
        min={min}
        placeholder="0"
        aria-label={ariaLabel}
        value={value}
        onChange={(ev) => onChange(ev.target.value)}
      />
      <button
        type="button"
        className="stake-step"
        aria-label="Increase stake"
        onClick={() => setVal(num + step)}
      >
        +
      </button>
    </div>
  );
};

export default StakeStepper;
