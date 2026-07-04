// Viewer's preferred display timezone. Set from Account settings, cached in
// localStorage so every page can read it synchronously without an extra
// account fetch. Defaults to Eastern until the viewer picks something else.
export const DEFAULT_TIMEZONE = 'America/New_York';

export const TIMEZONE_OPTIONS = [
  { value: 'America/Los_Angeles', label: 'Pacific Time (PT)' },
  { value: 'America/Denver', label: 'Mountain Time (MT)' },
  { value: 'America/Chicago', label: 'Central Time (CT)' },
  { value: 'America/New_York', label: 'Eastern Time (ET)' },
  { value: 'America/Sao_Paulo', label: 'Brazil (BRT)' },
  { value: 'UTC', label: 'UTC' },
  { value: 'Europe/London', label: 'UK (GMT/BST)' },
  { value: 'Europe/Paris', label: 'Central Europe (CET)' },
  { value: 'Asia/Dubai', label: 'Gulf Standard Time (GST)' },
  { value: 'Asia/Kolkata', label: 'India (IST)' },
  { value: 'Asia/Seoul', label: 'Korea (KST)' },
  { value: 'Asia/Tokyo', label: 'Japan (JST)' },
  { value: 'Australia/Sydney', label: 'Australia East (AEST/AEDT)' },
];

export function getUserTimezone() {
  try {
    return localStorage.getItem('timezone') || DEFAULT_TIMEZONE;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

export function setUserTimezone(tz) {
  try {
    localStorage.setItem('timezone', tz || DEFAULT_TIMEZONE);
  } catch {
    // localStorage unavailable (e.g. private mode) - display just falls back
    // to DEFAULT_TIMEZONE on next read.
  }
}
