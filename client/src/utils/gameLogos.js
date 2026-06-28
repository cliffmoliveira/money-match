// Utility to resolve game title images. Looks for files under public/assets/games.
// Example path: /assets/games/street-fighter-6.png

export const gameSlugMap = {
  'Street Fighter 6': 'street-fighter-6',
  'Tekken 8': 'tekken-8',
  'Guilty Gear Strive': 'guilty-gear-strive',
  'Dragon Ball FighterZ': 'dragon-ball-fighterz',
  'Mortal Kombat 1': 'mortal-kombat-1',
  'The King of Fighters XV': 'king-of-fighters-xv',
  'King of Fighters XV': 'king-of-fighters-xv', // Alias
  'Fatal Fury: City of the Wolves': 'fatal-fury-city-of-the-wolves',
  'Granblue Fantasy Versus Rising': 'granblue-fantasy-versus-rising',
  'Under Night In-Birth 2 [Sys:celes]': 'under-night-in-birth-2-sysceles',
  'Marvel vs. Capcom 2': 'marvel-vs-capcom-2',
  'Super Smash Bros. Ultimate': 'super-smash-bros-ultimate',
  'Super Smash Bros. Melee': 'super-smash-bros-melee',
  'Rivals of Aether 2': 'rivals-of-aether-ii', // Corrected slug
  'Rivals of Aether II': 'rivals-of-aether-ii', // Alias
  'Street Fighter 3: 3rd Strike': 'street-fighter-iii-third-strike', // Corrected slug
  'Street Fighter III: 3rd Strike': 'street-fighter-iii-third-strike', // Alias
  'Ultimate Marvel vs. Capcom 3': 'ultimate-marvel-vs-capcom-3',
  'Capcom vs. SNK 2': 'capcom-vs-snk-2',
  'Super Street Fighter 2: Turbo': 'super-street-fighter-ii-turbo', // Corrected slug
  'Super Street Fighter II: Turbo': 'super-street-fighter-ii-turbo', // Alias
  'Virtua Fighter 5 R.E.V.O.': 'virtua-fighter-5-revo', // Corrected slug
  'Virtua Fighter 5 R.E.V.O. World Stage': 'virtua-fighter-5-revo', // Evo 2026 name
  // Evo 2026 additions (assets are Start.gg box art — swap for transparent logos when available)
  '2XKO': '2xko',
  'BlazBlue: Central Fiction': 'blazblue-central-fiction',
  'Invincible Vs.': 'invincible-vs',
  'Invincible VS': 'invincible-vs', // event/display alias
  'Vampire Savior: The Lord of Vampire': 'vampire-savior',
  'Vampire Savior': 'vampire-savior', // alias
  'Under Night In-Birth II Sys:Celes': 'under-night-in-birth-2-sysceles', // Evo 2026 name
  // start.gg all-caps / punctuation variants
  'TEKKEN 8': 'tekken-8',
  'DRAGON BALL FighterZ': 'dragon-ball-fighterz',
  'Granblue Fantasy Versus: Rising': 'granblue-fantasy-versus-rising',
  'Guilty Gear: Strive': 'guilty-gear-strive',
  'Guilty Gear -Strive-': 'guilty-gear-strive',
};

// Per-game visual tuning (very wide logos, etc.) by slug
const logoScaleMap = {
  'guilty-gear-strive': 0.7, // reduce visual size
};
const logoMaxWidthMap = {
  'guilty-gear-strive': 200, // cap width (px)
};

// Per-game custom styles (e.g., for specific logo heights, margins)
const customStyles = {
  'Dragon Ball FighterZ': { height: 28 },
  'Super Smash Bros. Melee': { height: 52, marginTop: -16, marginBottom: -16 },
  'Rivals of Aether 2': { height: 48, marginTop: -12, marginBottom: -12 },
  'Rivals of Aether II': { height: 48, marginTop: -12, marginBottom: -12 }, // Alias
  'Street Fighter 3: 3rd Strike': { height: 36 },
  'Street Fighter III: 3rd Strike': { height: 36 }, // Alias
  'Ultimate Marvel vs. Capcom 3': { height: 40 },
  'Capcom vs. SNK 2': { height: 48, marginTop: -12, marginBottom: -12 },
  'Super Street Fighter 2: Turbo': { height: 48, marginTop: -12, marginBottom: -12 },
  'Super Street Fighter II: Turbo': { height: 48, marginTop: -12, marginBottom: -12 }, // Alias
  'Virtua Fighter 5 R.E.V.O.': { height: 48, marginTop: -12, marginBottom: -12 },
};

function slugifyGameName(name) {
  if (!name) return '';
  // Correctly look up the slug from the single source of truth.
  const explicit = gameSlugMap[name];
  if (explicit) return explicit;
  
  // Fallback for names not in the map.
  return String(name)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, '') // remove bracketed parts
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function getGameLogoSrc(name) {
  const slug = slugifyGameName(name);
  if (!slug) return null;
  const base = process.env.PUBLIC_URL || '';
  return `${base}/assets/games/${slug}.png`;
}

export function getGameAlt(name) {
  return `${name} logo`;
}

// The exact logo file that ships for each game slug, preferring transparent
// vector, then webp/png. Loading this one URL avoids a fallback storm of 404s
// (which on the dev server return index.html and can make a logo flicker to its
// text label) and keeps each logo to a single network hit.
const logoFileBySlug = {
  '2xko': '2xko.png',
  'blazblue-central-fiction': 'blazblue-central-fiction.webp',
  'capcom-vs-snk-2': 'capcom-vs-snk-2.png',
  'dragon-ball-fighterz': 'dragon-ball-fighterz.png',
  'fatal-fury-city-of-the-wolves': 'fatal-fury-city-of-the-wolves.png',
  'granblue-fantasy-versus-rising': 'granblue-fantasy-versus-rising.webp',
  'guilty-gear-strive': 'guilty-gear-strive.png',
  'invincible-vs': 'invincible-vs.svg',
  'king-of-fighters-xv': 'king-of-fighters-xv.png',
  'marvel-vs-capcom-2': 'marvel-vs-capcom-2.webp',
  'mortal-kombat-1': 'mortal-kombat-1.png',
  'rivals-of-aether-ii': 'rivals-of-aether-ii.png',
  'street-fighter-6': 'street-fighter-6.webp',
  'street-fighter-iii-third-strike': 'street-fighter-iii-third-strike.webp',
  'super-smash-bros-melee': 'super-smash-bros-melee.webp',
  'super-smash-bros-ultimate': 'super-smash-bros-ultimate.png',
  'super-street-fighter-ii-turbo': 'super-street-fighter-ii-turbo.png',
  'tekken-8': 'tekken-8.png',
  'ultimate-marvel-vs-capcom-3': 'ultimate-marvel-vs-capcom-3.webp',
  'under-night-in-birth-2-sysceles': 'under-night-in-birth-2-sysceles.webp',
  'vampire-savior': 'vampire-savior.png',
  'virtua-fighter-5-revo': 'virtua-fighter-5-revo.png',
};

export function getGameLogoSources(name) {
  const empty = { svg: null, avif: null, webp: null, png: null, jpg: null, jpeg: null };
  const slug = slugifyGameName(name);
  if (!slug) return empty;
  const base = process.env.PUBLIC_URL || '';
  const file = logoFileBySlug[slug];
  if (file) {
    // Known game: one authoritative URL, keyed by its real extension.
    const ext = file.slice(file.lastIndexOf('.') + 1);
    return { ...empty, [ext]: `${base}/assets/games/${file}` };
  }
  // Unknown game (not in the manifest yet): try the extensions we might ship,
  // skipping ones we never produce (.avif/.jpeg).
  return {
    ...empty,
    svg: `${base}/assets/games/${slug}.svg`,
    webp: `${base}/assets/games/${slug}.webp`,
    png: `${base}/assets/games/${slug}.png`,
    jpg: `${base}/assets/games/${slug}.jpg`,
  };
}

// Color treatment so dark/black wordmarks read on the dark sportsbook theme.
// brightness(0) invert(1) => flat white silhouette (these ship as dark artwork
// on a transparent background). Super Smash Bros. and TEKKEN 8 are handled at
// the asset level instead (Smash's white box baked to transparency + white
// text; TEKKEN's lettering whitened while keeping its red "8").
const logoTreatmentMap = {
  'street-fighter-6': { filter: 'brightness(0) invert(1)' },
  'guilty-gear-strive': { filter: 'brightness(0) invert(1)' },
};

export function getGameLogoStyle(name, baseHeight) {
  const slug = slugifyGameName(name);

  const baseStyle = {
    height: `${baseHeight || 32}px`, 
    maxHeight: `${baseHeight || 32}px`, 
    maxWidth: '180px', // Generous max-width for table cell
    objectFit: 'contain',
    verticalAlign: 'middle',
  };
  
  const customStyle = customStyles[name] || {};

  // For PastResults, we want uniform height, so we omit custom height properties
  // but keep other transforms like margins if needed.
  delete customStyle.height;

  return { ...baseStyle, ...customStyle, ...(logoTreatmentMap[slug] || {}) };
}

export function getGameLogoSourcesList(name) {
  const base = process.env.PUBLIC_URL || '';
  const slug = slugifyGameName(name);
  if (!slug) return [];
  return [
    `${base}/assets/games/${slug}.svg`,
    `${base}/assets/games/${slug}.avif`,
    `${base}/assets/games/${slug}.webp`,
    `${base}/assets/games/${slug}.png`,
  ];
}


