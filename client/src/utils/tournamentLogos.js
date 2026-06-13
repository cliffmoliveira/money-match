// Utilities for resolving tournament logo assets under public/assets/tournaments

const explicitSlugMap = {
  'EVO': 'evo',
  'Red Bull Kumite': 'red-bull-kumite',
  'Combo Breaker': 'combo-breaker',
  'CEO': 'ceo',
  'DreamHack': 'dreamhack',
  'Frosty Faustings': 'frosty-faustings',
  'Capcom Cup': 'capcom-cup',
  'Capcom Pro Tour': 'capcom-pro-tour',
  'CPT': 'capcom-pro-tour',
  'Texas Showdown': 'texas-showdown',
  'EVO Japan': 'evo-japan',
};

// Brand patterns to coerce any location/date variants to the base tournament slug
const brandPatterns = [
  { keywords: ['evo', 'las', 'vegas'], slug: 'evo' },
  { keywords: ['evo'], slug: 'evo' },
  { keywords: ['dreamhack'], slug: 'dreamhack' },
  { keywords: ['combo', 'breaker'], slug: 'combo-breaker' },
  { keywords: ['red', 'bull', 'kumite'], slug: 'red-bull-kumite' },
  { keywords: ['frosty', 'faustings'], slug: 'frosty-faustings' },
  { keywords: ['capcom', 'pro', 'tour'], slug: 'capcom-pro-tour' },
  { keywords: ['capcom', 'cup'], slug: 'capcom-cup' },
  { keywords: ['ceotaku'], slug: 'ceotaku' },
  { keywords: ['ceo'], slug: 'ceo' },
  { keywords: ['ultimate', 'fighting', 'arena'], slug: 'ufa' },
  { keywords: ['the', 'mixup'], slug: 'the-mixup' },
  { keywords: ['vsfighting'], slug: 'vsfighting' },
  { keywords: ['texas', 'showdown'], slug: 'texas-showdown' },
  { keywords: ['east', 'coast', 'throwdown'], slug: 'east-coast-throwdown' },
  { keywords: ['eglx'], slug: 'eglx' },
];

export function getTournamentSlug(name) {
  if (!name) return '';
  
  // Exact explicit brand mappings
  const explicit = explicitSlugMap[name] || explicitSlugMap[String(name).trim()];
  if (explicit) {
    return explicit;
  }
  
  // Pattern-based brand detection (normalize to base brand only)
  const input = String(name).toLowerCase();
  // Normalize punctuation/hyphens to spaces so patterns with \s* match hyphenated titles
  const normalized = input.replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();

  // New, more robust brand detection
  for (const pattern of brandPatterns) {
      // A simple 'includes' check is often more reliable than complex regex
      // for this kind of brand name matching.
      const keywords = pattern.keywords || [];
      const found = keywords.every(kw => normalized.includes(kw));

      if (found) {
          return pattern.slug;
      }
  }
  
  // Generic fallback: use first non-stopword token as brand slug
  const stop = new Set(['the', 'a', 'an', 'of', 'at', 'in', 'on', 'by', 'for', 'and']);
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const first = tokens.find(t => !stop.has(t)) || tokens[0] || '';
  
  if (first) return first;
  
  // Last resort: full slug
  const fullSlug = String(name)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return fullSlug;
}

export function getTournamentLogoSources(name) {
  const slug = getTournamentSlug(name);
  if (!slug) return { webp: null, png: null, jpg: null, jpeg: null };
  const base = process.env.PUBLIC_URL || '';
  return {
    avif: `${base}/assets/tournaments/${slug}.avif`,
    webp: `${base}/assets/tournaments/${slug}.webp`,
    png: `${base}/assets/tournaments/${slug}.png`,
    jpg: `${base}/assets/tournaments/${slug}.jpg`,
    jpeg: `${base}/assets/tournaments/${slug}.jpeg`,
  };
}

export function getTournamentAlt(name) {
  return name || 'Tournament';
}

export function getTournamentLogoStyle(name, baseHeight) {
  const height = Math.max(1, Math.round((baseHeight || 32)));
  return { maxHeight: `${height}px`, objectFit: 'contain' };
}

function slugifyTournamentNameRaw(name) {
  return String(name)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Build a list of candidate slugs to try (specific → generic fallbacks)
export function getTournamentLogoCandidateSlugs(name) {
  const base = getTournamentSlug(name);
  if (!base) return [];
  const raw = slugifyTournamentNameRaw(name);
  const list = [base];
  if (raw && raw !== base) list.push(raw);
  return list;
}

export function getTournamentLogoSourcesList(name) {
  const base = process.env.PUBLIC_URL || '';
  const slugs = getTournamentLogoCandidateSlugs(name);
  const urls = [];
  slugs.forEach((slug) => {
    urls.push(`${base}/assets/tournaments/${slug}.avif`);
    urls.push(`${base}/assets/tournaments/${slug}.webp`);
    urls.push(`${base}/assets/tournaments/${slug}.png`);
    urls.push(`${base}/assets/tournaments/${slug}.jpg`);
    urls.push(`${base}/assets/tournaments/${slug}.jpeg`);
  });
  return urls;
}


