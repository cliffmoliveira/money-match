/**
 * Deterministic "beam"-style face avatars (the Boring Avatars look), generated
 * locally as SVG data URLs — no network, no image library, stable per seed.
 * Rendered inside an <img>, so the SVG is a non-scripting context (safe).
 * Port of the MIT-licensed boring-avatars "beam" variant.
 */
const SIZE = 36;

// A vibrant, leaderboard-friendly palette.
const PALETTE = [
  '#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51',
  '#1d3557', '#457b9d', '#a8dadc', '#e63946', '#06d6a0',
  '#118ab2', '#ef476f', '#ffd166', '#8338ec', '#3a86ff',
];

function hashCode(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0; // 32-bit int
  }
  return Math.abs(hash);
}
const getDigit = (n, nth) => Math.floor((n / Math.pow(10, nth)) % 10);
const getBoolean = (n, nth) => !(getDigit(n, nth) % 2);
const getAngle = (n) => n % 360;
function getUnit(n, range, index) {
  let value = n % range;
  if (index && getDigit(n, index) % 2 === 0) value = -value;
  return value;
}
function contrast(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 128 ? '#000000' : '#ffffff';
}
const color = (n) => PALETTE[n % PALETTE.length];

function beamSvg(name) {
  const num = hashCode(name);
  const wrapperColor = color(num);
  const faceColor = contrast(wrapperColor);
  const backgroundColor = color(num + 13);
  const preTX = getUnit(num, 10, 1);
  const wrapperTranslateX = preTX < 5 ? preTX + SIZE / 9 : preTX;
  const preTY = getUnit(num, 10, 2);
  const wrapperTranslateY = preTY < 5 ? preTY + SIZE / 9 : preTY;
  const wrapperRotate = getAngle(num);
  const wrapperScale = 1 + getUnit(num, Math.floor(SIZE / 12)) / 10;
  const isMouthOpen = getBoolean(num, 2);
  const isCircle = getBoolean(num, 1);
  const eyeSpread = getUnit(num, 5);
  const mouthSpread = getUnit(num, 3);
  const faceRotate = getUnit(num, 10, 3);
  const faceTranslateX = wrapperTranslateX > SIZE / 6 ? wrapperTranslateX / 2 : getUnit(num, 8, 1);
  const faceTranslateY = wrapperTranslateY > SIZE / 6 ? wrapperTranslateY / 2 : getUnit(num, 7, 2);
  const mouth = isMouthOpen
    ? `<path d="M15 ${19 + mouthSpread}c2 1 4 1 6 0" stroke="${faceColor}" fill="none" stroke-linecap="round"/>`
    : `<path d="M13,${19 + mouthSpread} a1,0.75 0 0,0 10,0" fill="${faceColor}"/>`;
  return [
    `<svg viewBox="0 0 ${SIZE} ${SIZE}" fill="none" xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">`,
    `<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${SIZE}" height="${SIZE}"><rect width="${SIZE}" height="${SIZE}" rx="${SIZE * 2}" fill="#fff"/></mask>`,
    `<g mask="url(#m)">`,
    `<rect width="${SIZE}" height="${SIZE}" fill="${backgroundColor}"/>`,
    `<rect x="0" y="0" width="${SIZE}" height="${SIZE}" transform="translate(${wrapperTranslateX} ${wrapperTranslateY}) rotate(${wrapperRotate} ${SIZE / 2} ${SIZE / 2}) scale(${wrapperScale})" fill="${wrapperColor}" rx="${isCircle ? SIZE : SIZE / 6}"/>`,
    `<g transform="translate(${faceTranslateX} ${faceTranslateY}) rotate(${faceRotate} ${SIZE / 2} ${SIZE / 2})">`,
    mouth,
    `<rect x="${14 - eyeSpread}" y="14" width="1.5" height="2" rx="1" fill="${faceColor}"/>`,
    `<rect x="${20 + eyeSpread}" y="14" width="1.5" height="2" rx="1" fill="${faceColor}"/>`,
    `</g></g></svg>`,
  ].join('');
}

function beamAvatarDataUrl(name) {
  return 'data:image/svg+xml;base64,' + Buffer.from(beamSvg(String(name || '?'))).toString('base64');
}

module.exports = { beamAvatarDataUrl, beamSvg };
