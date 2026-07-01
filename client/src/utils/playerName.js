// Start.gg tags carry "TEAM | gamerTag" (English) or "日本語名/RomanTag" (Japanese).
// Nested team prefixes ("TM | RB | Arslan Ash") are also common: take the first
// segment as the sponsor label and the LAST segment as the gamerTag so intermediate
// org tiers don't bleed through as a visible pipe in the name.
// For /, only treat it as a separator when the left side contains Japanese/CJK characters —
// otherwise "/" is two players on a 2v2 team (e.g. 2XKO) and should stay intact.
const hasJapanese = (s) => /[぀-ヿ一-鿿＀-￯]/.test(s);

export const splitPlayerName = (name) => {
  if (!name) return { sponsor: '', tag: name };
  const pi = name.indexOf('|');
  if (pi !== -1) {
    const sponsor = name.slice(0, pi).trim();
    const rest = name.slice(pi + 1).trim();
    // Nested prefixes: take only the segment after the last pipe as the gamerTag
    const lastPipe = rest.lastIndexOf('|');
    const tag = lastPipe !== -1 ? rest.slice(lastPipe + 1).trim() : rest;
    return { sponsor, tag };
  }
  const si = name.indexOf('/');
  if (si !== -1 && hasJapanese(name.slice(0, si))) {
    return { sponsor: name.slice(0, si).trim(), tag: name.slice(si + 1).trim() };
  }
  return { sponsor: '', tag: name };
};

export const shortPlayerName = (name) => splitPlayerName(name).tag || name;
