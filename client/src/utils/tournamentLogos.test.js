import { getTournamentSlug, hasTournamentLogo } from './tournamentLogos';

// Regression test: "Esports World Cup" had no brand pattern, so every EWC
// tournament (LCQ or main stage) fell through to the generic first-word
// fallback ('esports'), which has no bundled asset - every card silently
// dropped to the raw start.gg promotional banner instead of a real logo.
test('Esports World Cup resolves to one brand slug across LCQ and main-stage names', () => {
  const names = [
    'Esports World Cup 2026: FATAL FURY: City of the Wolves',
    'Esports World Cup 2026: FATAL FURY: City of the Wolves - LCQ',
    'Esports World Cup 2026: Street Fighter 6 - LCQ',
    'Esports World Cup 2026: TEKKEN 8 - LCQ',
    'Esports World Cup 2025 - TEKKEN 8 LCQ',
  ];
  for (const name of names) {
    expect(getTournamentSlug(name)).toBe('esports-world-cup');
  }
});

test('hasTournamentLogo only reports true for brands with a real bundled asset', () => {
  expect(hasTournamentLogo('Esports World Cup 2026: TEKKEN 8 - LCQ')).toBe(true);
  expect(hasTournamentLogo('EVO 2026')).toBe(true);
  // VSFighting has a brand slug (so getTournamentSlug resolves cleanly) but
  // no logo file has ever been added under public/assets/tournaments/ -
  // this must stay false until one actually exists there.
  expect(hasTournamentLogo('VSFighting XIV')).toBe(false);
  expect(hasTournamentLogo('Some Random Local Weekly #42')).toBe(false);
});
