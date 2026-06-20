// Fight Money — the play-money betting currency. Stored server-side as integer
// cents (1 FM = 100 cents). Displayed as whole FM with thousands separators, and
// only shows decimals when the amount is fractional (e.g. a parimutuel payout).

export function fmAmount(cents) {
  const fm = (Number(cents) || 0) / 100;
  const whole = Number.isInteger(fm);
  return fm.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

// "1,000 FM"
export function fm(cents) {
  return `${fmAmount(cents)} FM`;
}

// Signed, for win/loss P&L: "+1,250 FM" / "−500 FM"
export function fmSigned(cents) {
  const n = Number(cents) || 0;
  return `${n >= 0 ? '+' : '−'}${fmAmount(Math.abs(n))} FM`;
}
