/**
 * Editable user profile / account settings. Adds optional profile columns to the
 * users table and updates them with per-field validation. Only fields in the
 * whitelist below can ever be written (no mass assignment), and display_name is
 * the one required field — everything else is optional and clears to NULL when
 * blank.
 */
const db = require('./db/db');

// field -> validation/normalization rules. `label` is used in error messages.
const FIELDS = {
  display_name:   { required: true, min: 2, max: 30, label: 'Display name' },
  full_name:      { max: 80, label: 'Full name' },
  birthday:       { date: true, label: 'Birthday' },
  gender:         { max: 30, label: 'Gender' },
  pronouns:       { max: 30, label: 'Pronouns' },
  country:        { max: 56, label: 'Country' },
  team:           { max: 40, label: 'Team / sponsor' },
  favorite_game:  { max: 60, label: 'Favorite game' },
  main_character: { max: 60, label: 'Main' },
  bio:            { max: 280, label: 'Bio' },
  twitch:         { max: 40, handle: true, label: 'Twitch' },
  twitter:        { max: 40, handle: true, label: 'X / Twitter' },
  discord:        { max: 40, label: 'Discord' },
  // Avatar as a small base64 image data URL (client resizes to ~256px). SVG is
  // intentionally excluded. Generous cap as a safety backstop; blank clears it.
  avatar:         { max: 1500000, image: true, label: 'Avatar' },
};
const COLUMNS = Object.keys(FIELDS);

async function applyAccountSchema(database = db) {
  const cols = await database.allAsync('PRAGMA table_info(users)');
  const have = new Set(cols.map((c) => c.name));
  for (const col of COLUMNS) {
    if (!have.has(col)) await database.runAsync(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
  }
  // Backfill display_name from the login username so everyone has a public name.
  await database.runAsync(
    "UPDATE users SET display_name = username WHERE display_name IS NULL OR TRIM(display_name) = ''"
  );
}

async function getAccount(userId) {
  return db.getAsync(`SELECT id, username, email, ${COLUMNS.join(', ')} FROM users WHERE id = ?`, [userId]);
}

function fail(field, message) {
  const e = new Error(message);
  e.code = 'VALIDATION';
  e.field = field;
  return e;
}

// Validate + normalize one field. Returns the value to store (string or NULL).
function clean(field, raw) {
  const spec = FIELDS[field];
  let v = raw == null ? '' : String(raw).trim();
  if (v === '') {
    if (spec.required) throw fail(field, `${spec.label} is required.`);
    return null; // optional + blank -> clear the field
  }
  if (spec.min && v.length < spec.min) throw fail(field, `${spec.label} must be at least ${spec.min} characters.`);
  if (spec.max && v.length > spec.max) throw fail(field, `${spec.label} must be ${spec.max} characters or fewer.`);
  if (spec.handle) {
    v = v.replace(/^@+/, ''); // accept "@name" or "name"
    if (v === '') return null; // an all-@ handle clears the field, like any blank optional
  }
  if (spec.date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw fail(field, 'Birthday must be a valid date (YYYY-MM-DD).');
    // Date.parse rolls impossible dates forward (Feb 30 -> Mar 2), so round-trip
    // and reject anything that doesn't normalize back to the same calendar day.
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw fail(field, 'Birthday is not a real date.');
    if (d.getTime() > Date.now()) throw fail(field, 'Birthday can’t be in the future.');
  }
  if (spec.image && !/^data:image\/(png|jpe?g|webp|gif);base64,/i.test(v)) {
    // Reject anything that isn't a raster image data URL (no SVG -> no script payloads).
    throw fail(field, 'Avatar must be a PNG, JPEG, WebP, or GIF image.');
  }
  return v;
}

// Update only the provided whitelisted fields for this user. Throws a VALIDATION
// error (mapped to 400) on bad input. Returns { account } or { error:'NOT_FOUND' }.
async function updateAccount(userId, patch = {}) {
  const exists = await db.getAsync('SELECT id FROM users WHERE id = ?', [userId]);
  if (!exists) return { error: 'NOT_FOUND' };

  const sets = [];
  const vals = [];
  for (const field of COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      sets.push(`${field} = ?`);
      vals.push(clean(field, patch[field])); // validates; throws on bad input
    }
  }
  if (sets.length) {
    vals.push(userId);
    await db.runAsync(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, vals);
  }
  return { account: await getAccount(userId) };
}

module.exports = { applyAccountSchema, getAccount, updateAccount, FIELDS, COLUMNS };
