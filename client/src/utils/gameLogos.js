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

export function getGameLogoSources(name) {
  const slug = slugifyGameName(name);
  if (!slug) return { avif: null, webp: null, png: null, jpg: null, jpeg: null };
  const base = process.env.PUBLIC_URL || '';
  return {
    avif: `${base}/assets/games/${slug}.avif`,
    webp: `${base}/assets/games/${slug}.webp`,
    png: `${base}/assets/games/${slug}.png`,
    jpg: `${base}/assets/games/${slug}.jpg`,
    jpeg: `${base}/assets/games/${slug}.jpeg`,
  };
}

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

  return { ...baseStyle, ...customStyle };
}

export function getGameLogoSourcesList(name) {
  const base = process.env.PUBLIC_URL || '';
  const slug = slugifyGameName(name);
  if (!slug) return [];
  return [
    `${base}/assets/games/${slug}.avif`,
    `${base}/assets/games/${slug}.webp`,
    `${base}/assets/games/${slug}.png`,
  ];
}


