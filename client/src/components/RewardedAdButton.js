import React, { useEffect, useState } from 'react';
import './RewardedAdButton.css';
import { showRewardedAd, trackAdEvent } from '../utils/ads';
import { apiFetch } from '../utils/api';
import { fm } from '../utils/money';

// "Watch a video → +FM" entry point. Plays the rewarded ad (ads.js seam), then
// claims the server-side reward and reports the new balance via onReward. The
// server is the source of truth for eligibility + the credit. `cooldownMs` is
// the remaining throttle from the server so the button is accurate on open —
// during a cooldown the button is disabled and counts down (no wasted watches).
const RewardedAdButton = ({ placement = 'reward-popover', onReward, cooldownMs = 0 }) => {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [remaining, setRemaining] = useState(cooldownMs || 0);

  // Adopt a fresh server-provided cooldown when the popover reopens / wallet polls.
  useEffect(() => { setRemaining(cooldownMs || 0); }, [cooldownMs]);

  // Tick the cooldown down to zero, then re-enable.
  useEffect(() => {
    if (remaining <= 0) return undefined;
    const id = setInterval(() => setRemaining((r) => Math.max(0, r - 1000)), 1000);
    return () => clearInterval(id);
  }, [remaining > 0]);

  const onCooldown = remaining > 0;

  const run = async () => {
    if (busy || onCooldown) return;
    setBusy(true);
    setMsg(null);
    try {
      const { completed } = await showRewardedAd({ placement });
      if (!completed) { setMsg('Watch the full video to earn.'); setBusy(false); return; }
      const res = await apiFetch('/api/wallet/ad-reward', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.granted) {
        trackAdEvent('reward_granted', { placement, amountCents: data.amountCents });
        if (data.balanceCents != null && onReward) onReward(data.balanceCents);
        setMsg(`+${fm(data.amountCents)} added!`);
        setRemaining(data.cooldownMs || 60000);
      } else if (res.status === 429) {
        setRemaining(data.retryInMs || 60000);
      } else {
        setMsg('Could not grant the reward.');
      }
    } catch {
      setMsg('Ad unavailable right now.');
    } finally {
      setBusy(false);
    }
  };

  const label = onCooldown
    ? `🎬 Watch again in ${Math.ceil(remaining / 1000)}s`
    : busy ? 'Loading…' : '🎬 Watch a video for +25 FM';

  return (
    <div className="rewarded-ad">
      <button type="button" className="rewarded-ad-btn" onClick={run} disabled={busy || onCooldown}>
        {label}
      </button>
      {msg && <div className="rewarded-ad-msg">{msg}</div>}
    </div>
  );
};

export default RewardedAdButton;
