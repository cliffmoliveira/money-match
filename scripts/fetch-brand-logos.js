/**
 * Replace the hand-picked local tournament banners with square profile logos
 * from start.gg, so they match the look of the backfilled tournament logos.
 *
 * For each brand it searches start.gg by name, picks the best-matching
 * tournament that has a square "profile" image (preferring higher attendance),
 * downloads it, and writes it to client/public/assets/tournaments/<slug>.png.
 *
 * Usage: node scripts/fetch-brand-logos.js [--dry-run]
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const axios = require('axios');
const { startgg } = require('../startggClient');

const ASSET_DIR = path.join(__dirname, '..', 'client', 'public', 'assets', 'tournaments');
const DRY_RUN = process.argv.includes('--dry-run');

// slug = output filename; search = start.gg name filter; match = substring the
// winning tournament name should contain (case-insensitive) to avoid grabbing
// an unrelated local weekly that happens to share a word.
const BRANDS = [
  { slug: 'evo',              search: 'Evo',              match: 'evo' },
  { slug: 'ceo',              search: 'CEO',              match: 'ceo' },
  { slug: 'combo-breaker',    search: 'Combo Breaker',    match: 'combo breaker' },
  { slug: 'capcom-cup',       search: 'Capcom Cup',       match: 'capcom cup' },
  { slug: 'capcom-pro-tour',  search: 'Capcom Pro Tour',  match: 'capcom' },
  { slug: 'dreamhack',        search: 'DreamHack',        match: 'dreamhack' },
  { slug: 'frosty-faustings', search: 'Frosty Faustings', match: 'frosty faustings' },
  { slug: 'red-bull-kumite',  search: 'Red Bull Kumite',  match: 'red bull kumite' },
];

const SEARCH = `
query BrandSearch($name: String!) {
  tournaments(query: { perPage: 50, page: 1, filter: { name: $name } }) {
    nodes { name numAttendees images { type url } }
  }
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickProfileUrl(images = []) {
  // "profile" is the square logo; ignore wide "banner" images.
  return images.find((i) => i.type === 'profile')?.url || null;
}

function extOf(url) {
  const clean = url.split('?')[0];
  const m = clean.match(/\.(png|jpg|jpeg|webp|avif)$/i);
  return m ? m[1].toLowerCase() : 'png';
}

async function download(url, destNoExt) {
  const ext = extOf(url);
  const dest = `${destNoExt}.${ext}`;
  const res = await axios.get(url, { responseType: 'arraybuffer' });
  fs.writeFileSync(dest, Buffer.from(res.data));
  return dest;
}

// The slug resolver tries .avif/.webp/.png/.jpg/.jpeg in order, so a leftover
// old file with a different extension could shadow the new one. Remove them.
function removeStaleVariants(slug, keepPath) {
  for (const ext of ['avif', 'webp', 'png', 'jpg', 'jpeg']) {
    const p = path.join(ASSET_DIR, `${slug}.${ext}`);
    if (p !== keepPath && fs.existsSync(p)) {
      if (!DRY_RUN) fs.unlinkSync(p);
      console.log(`  removed stale ${path.basename(p)}`);
    }
  }
}

(async () => {
  for (const brand of BRANDS) {
    try {
      const data = await startgg(SEARCH, { name: brand.search });
      const withLogo = (data?.tournaments?.nodes || [])
        .filter((n) => pickProfileUrl(n.images))
        .sort((a, b) => (b.numAttendees || 0) - (a.numAttendees || 0));

      // Prefer the flagship: name starts with the brand (e.g. "Combo Breaker
      // 2025"), not a side event ("... at Combo Breaker"). Fall back to any
      // name that contains the brand.
      const startsWith = withLogo.filter((n) => n.name.toLowerCase().startsWith(brand.match));
      const contains = withLogo.filter((n) => n.name.toLowerCase().includes(brand.match));
      const best = startsWith[0] || contains[0];
      if (!best) {
        console.log(`${brand.slug}: no profile logo found, leaving existing file.`);
        await sleep(800);
        continue;
      }

      const url = pickProfileUrl(best.images);
      console.log(`${brand.slug}: "${best.name}" (${best.numAttendees || '?'} attendees)`);
      if (DRY_RUN) {
        console.log(`  [dry-run] would download ${url}`);
      } else {
        const dest = await download(url, path.join(ASSET_DIR, brand.slug));
        removeStaleVariants(brand.slug, dest);
        console.log(`  saved ${path.basename(dest)}`);
      }
    } catch (err) {
      console.error(`${brand.slug}: ERROR ${err.message}`);
    }
    await sleep(900);
  }
  console.log('\nDone.');
  process.exit(0);
})();
