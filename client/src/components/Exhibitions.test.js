import { screen, waitFor } from '@testing-library/react';
import Exhibitions from './Exhibitions';
import { renderWithRouter, mockFetchRoutes } from '../testUtils';

// Both fetches Exhibitions.js makes unconditionally on mount.
const BASE_ROUTES = [
  ['/api/exhibitions/live', []],
  ['/api/exhibitions/results', []],
];

afterEach(() => {
  jest.restoreAllMocks();
});

test('shows the empty state when there are no live or past exhibitions', async () => {
  mockFetchRoutes(BASE_ROUTES);

  renderWithRouter(<Exhibitions />);

  expect(screen.getByText(/loading exhibitions/i)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('No exhibitions yet')).toBeInTheDocument());
});

test('renders live exhibitions under "Live Exhibitions" and past ones under "Exhibition Results"', async () => {
  mockFetchRoutes([
    ['/api/exhibitions/live', [
      { id: 1, state: 'open', player1_name: 'Punk', player2_name: 'MenaRD', game_name: 'SF6', tournament_name: 'Evo 2026', notes: null },
    ]],
    ['/api/exhibitions/results', [
      {
        id: 2, state: 'settled', player1_name: 'Tokido', player2_name: 'NuckleDu',
        winner_name: 'Tokido', winner_score: 3, loser_score: 0,
        game_name: 'SF6', tournament_name: 'Frosty Faustings', tournament_logo_url: null,
        event_date: '2026-01-15T18:00:00Z', city: null, country: null,
      },
    ]],
  ]);

  renderWithRouter(<Exhibitions />);

  await waitFor(() => expect(screen.getByText('Live Exhibitions')).toBeInTheDocument());
  expect(screen.getByText('Punk')).toBeInTheDocument();
  expect(screen.getByText('Exhibition Results')).toBeInTheDocument();
  // Table layout renders both a desktop table and mobile cards, so each name appears twice.
  expect(screen.getAllByText('Tokido').length).toBeGreaterThan(0);
  expect(screen.getAllByText('NuckleDu').length).toBeGreaterThan(0);
});

test('treats a failed fetch as empty rather than staying stuck on the loading state', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }));

  renderWithRouter(<Exhibitions />);

  await waitFor(() => expect(screen.getByText('No exhibitions yet')).toBeInTheDocument());
});
