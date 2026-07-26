/**
 * Shared player-identity resolution for every Start.gg ingestion script.
 *
 * Start.gg has three different "id" concepts that are easy to conflate:
 *   - Entrant.id             — one tournament REGISTRATION. Changes every
 *                              time the same real person enters a new event.
 *   - Participant.id         — one person's participation within ONE
 *                              entrant. Also scoped to a single registration.
 *   - Participant.player.id  — the actual PERSON. Stable across every
 *                              tournament AND every sponsor change.
 *
 * Every ingestion script used to key players.startgg_id off Entrant.id (with
 * an exact-name fallback) — so the same real person got a brand new player
 * row every time their sponsor tag changed, since neither the entrant id nor
 * the display name matched anything already on file. This is what caused the
 * MenaRD Follow bug (2026-07-12): "MenaRD" (bare legacy name, from the
 * original matches-only backfill) and "WBG RB | MenaRD" (his actual synced
 * entrant record) were two unrelated rows — verified against the live
 * Start.gg API that participants[].player.id (224650) stays identical for
 * him across Evo 2026 / Combo Breaker 2026 / Blink Respawn 2026, while
 * entrant.id was different every single time.
 *
 * Only trustworthy for SOLO entrants: a multi-participant entrant (2v2
 * doubles teams, e.g. 2XKO) has one player.id PER teammate, and this app
 * tracks a doubles pairing as a single row keyed by the pairing itself (see
 * playerName.js) — there's no single stable "team id" to substitute, so team
 * entrants keep matching on entrant.id/name exactly as before. Not a
 * regression: doubles already worked this way.
 *
 * Every GraphQL entrant selection that feeds findOrCreatePlayerId must
 * include `participants { images { type url } player { id } }` (gamerTag/
 * prefix aren't needed server-side — the client already re-derives them from
 * the stored "SPONSOR | tag" name via splitPlayerName).
 */
const db = require('../../db/db');

// A participant's uploaded start.gg profile photo. Optional per player —
// many entrants never upload one.
function photoOf(entrant) {
  return entrant?.participants?.[0]?.images?.find((i) => i.type === 'profile')?.url || null;
}

// The id to key players.startgg_id on for this entrant.
function stableIdFor(entrant) {
  const participants = entrant?.participants || [];
  if (participants.length === 1 && participants[0]?.player?.id != null) {
    return participants[0].player.id;
  }
  return entrant?.id ?? null;
}

async function findOrCreatePlayerId(entrant) {
  const name = entrant?.name?.trim();
  if (!name) return null;
  const photoUrl = photoOf(entrant);
  const lookupId = stableIdFor(entrant);

  // Exact startgg_id match — already the row's own primary identity, so
  // there's nothing to self-heal.
  if (lookupId != null) {
    const byId = await db.getAsync('SELECT id FROM players WHERE startgg_id = ?', [lookupId]);
    if (byId) {
      if (photoUrl) await db.runAsync('UPDATE players SET photo_url = COALESCE(?, photo_url) WHERE id = ?', [photoUrl, byId.id]);
      return byId.id;
    }
  }

  // Known alias: a DIFFERENT start.gg account manually confirmed (via
  // merge-same-person-player.js) to be the same real person as an existing
  // row. Never overwrite the row's primary startgg_id here — that would
  // silently evict whichever id is currently primary and just move the
  // problem to the next sync under that account instead of fixing it.
  if (lookupId != null) {
    const viaAlias = await db.getAsync(
      `SELECT p.id FROM player_startgg_aliases a JOIN players p ON p.id = a.player_id WHERE a.startgg_id = ?`,
      [lookupId]
    );
    if (viaAlias) {
      if (photoUrl) await db.runAsync('UPDATE players SET photo_url = COALESCE(?, photo_url) WHERE id = ?', [photoUrl, viaAlias.id]);
      return viaAlias.id;
    }
  }

  // Exact name match: a row whose startgg_id is stale/null/a pre-fix
  // entrant-id value self-heals to the current stable id. Unconditional
  // overwrite (not COALESCE) so it always converges, rather than
  // permanently locking in whatever value was written first.
  const byName = await db.getAsync('SELECT id FROM players WHERE name = ?', [name]);
  if (byName) {
    await db.runAsync(
      'UPDATE players SET startgg_id = ?, photo_url = COALESCE(?, photo_url) WHERE id = ?',
      [lookupId, photoUrl, byName.id]
    );
    return byName.id;
  }

  const res = await db.runAsync(
    'INSERT INTO players (name, country, startgg_id, photo_url) VALUES (?, ?, ?, ?)',
    [name, '', lookupId, photoUrl]
  );
  return res.lastID;
}

module.exports = { findOrCreatePlayerId, photoOf, stableIdFor };
