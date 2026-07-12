/**
 * Server-side (CommonJS) mirror of client/src/utils/playerName.js — kept in
 * exact lockstep so a name splits/parses identically whether it's rendered
 * client-side or reasoned about server-side (follows.js's teammate lookup,
 * scripts/plan-legacy-player-merges.js's team-pairing exclusion). If you
 * change the parsing rules, change both files the same way.
 *
 * Start.gg tags carry "TEAM | gamerTag" (English) or "日本語名/RomanTag"
 * (Japanese). For "/", only treat it as a sponsor separator when the left
 * side contains Japanese/CJK characters — otherwise "/" is two players on a
 * 2v2 team (e.g. 2XKO) and should stay intact.
 */
const hasJapanese = (s) => /[぀-ヿ一-鿿＀-￯]/.test(s);

const romanize = (s) => {
  const si = s.indexOf('/');
  return si !== -1 && hasJapanese(s.slice(0, si)) ? s.slice(si + 1).trim() : s;
};

function splitPlayerName(name) {
  if (!name) return { sponsor: '', tag: name };
  const pi = name.indexOf('|');
  if (pi !== -1) {
    const sponsor = name.slice(0, pi).trim();
    const rest = name.slice(pi + 1).trim();
    const lastPipe = rest.lastIndexOf('|');
    const tag = lastPipe !== -1 ? rest.slice(lastPipe + 1).trim() : rest;
    return { sponsor, tag: romanize(tag) };
  }
  const si = name.indexOf('/');
  if (si !== -1 && hasJapanese(name.slice(0, si))) {
    return { sponsor: name.slice(0, si).trim(), tag: name.slice(si + 1).trim() };
  }
  return { sponsor: '', tag: name };
}

const shortPlayerName = (name) => splitPlayerName(name).tag || name;

// A name with no "|" and a "/" whose left segment isn't Japanese/CJK is a
// 2v2 team pairing ("Player1 / Player2"), not a sponsor+tag — see
// splitPlayerName above. Used to find/exclude doubles-team entrant rows.
function isTeamPairing(name) {
  if (!name || name.includes('|')) return false;
  const si = name.indexOf('/');
  return si !== -1 && !hasJapanese(name.slice(0, si));
}

module.exports = { splitPlayerName, shortPlayerName, isTeamPairing, hasJapanese };
