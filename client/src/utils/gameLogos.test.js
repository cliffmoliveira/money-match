import { getGameLogoSources } from './gameLogos';

// Real DB game names for the rhythm-game side events added at CEO 2026 -
// two of them (Dance Dance Revolution EXTREME Pro, StepManiaX) don't
// auto-slugify to their shipped filename, so they need an explicit
// gameSlugMap entry rather than relying on the generic fallback.
test('resolves the CEO 2026 rhythm-game logos to their real shipped filenames', () => {
  expect(getGameLogoSources('Dance Dance Revolution World').png)
    .toMatch(/dance-dance-revolution-world\.png$/);
  expect(getGameLogoSources('Dance Dance Revolution EXTREME Pro').png)
    .toMatch(/dance-dance-revolution-extreme\.png$/);
  expect(getGameLogoSources('ITGmania').png).toMatch(/itgmania\.png$/);
  expect(getGameLogoSources('Pump it Up Phoenix').webp).toMatch(/pump-it-up-phoenix\.webp$/);
  expect(getGameLogoSources('StepManiaX').png).toMatch(/step-mania-x\.png$/);
});
