// Rewarded-ad seam. To go live, swap ONLY the marked block in showRewardedAd()
// for a real provider (Google H5 Games Ads "Ad Placement API", or an offerwall
// SDK). Nothing else in the app needs to change.

// Analytics seam — point this at a real analytics sink later. For now it emits a
// DOM event (so the funnel is observable in-app/tests) and logs to the console.
export function trackAdEvent(event, data = {}) {
  const detail = { event, ...data };
  try { window.dispatchEvent(new CustomEvent('mm-ad-event', { detail })); } catch { /* noop */ }
  if (typeof console !== 'undefined' && console.info) console.info('[ad]', event, data);
}

// Play a rewarded video; resolves { completed: boolean }. The STUB simulates a
// short ad with a progress overlay so the loop is demoable end-to-end. The
// reward itself is granted server-side (see /api/wallet/ad-reward), never here.
export function showRewardedAd({ placement = 'unknown', seconds = 5 } = {}) {
  trackAdEvent('ad_requested', { placement });
  return new Promise((resolve) => {
    // ===== PROVIDER STUB — replace with Google H5 Ad Placement API / offerwall =====
    const overlay = document.createElement('div');
    overlay.className = 'mm-ad-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Rewarded ad');
    overlay.innerHTML = `
      <div class="mm-ad-card">
        <span class="mm-ad-tag">Ad · demo</span>
        <div class="mm-ad-title">Rewarded video</div>
        <div class="mm-ad-sub">A real ad plays here. Watch to the end to earn Fight Money.</div>
        <div class="mm-ad-track"><div class="mm-ad-fill"></div></div>
        <button class="mm-ad-skip" type="button">Skip</button>
      </div>`;
    document.body.appendChild(overlay);
    trackAdEvent('ad_shown', { placement });

    const fill = overlay.querySelector('.mm-ad-fill');
    fill.style.transition = `width ${seconds}s linear`;
    requestAnimationFrame(() => { fill.style.width = '100%'; });

    let settled = false;
    const finish = (completed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      overlay.remove();
      trackAdEvent(completed ? 'ad_completed' : 'ad_skipped', { placement });
      resolve({ completed });
    };
    const timer = setTimeout(() => finish(true), seconds * 1000);
    overlay.querySelector('.mm-ad-skip').addEventListener('click', () => finish(false));
    // ===== END PROVIDER STUB =====
  });
}
