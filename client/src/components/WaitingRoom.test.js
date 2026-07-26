import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import WaitingRoom from './WaitingRoom';
import { mockFetchRoutes, setLoggedOut } from '../testUtils';

// WaitingRoom.js has no react-router hooks of its own, so it's rendered
// directly (no renderWithRouter needed) - but it does fetch its own data
// (tracker + outright seeding, via useOutrightPicks) on mount, so every
// endpoint it hits has to be mocked or the fetch 404s into an empty state.
const tournament = {
  id: 1,
  name: 'VSFighting XIV',
  date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
  logoUrl: null,
};
const games = [
  { id: 5, name: 'Street Fighter 6' },
  { id: 6, name: 'Tekken 8' },
];

const BASE_ROUTES = [
  ['/api/game/1/5/tracker', { rounds: [], results: [], stillAlive: [] }],
  ['/api/game/1/6/tracker', { rounds: [], results: [], stillAlive: [] }],
  ['/api/game/1/5/players', {
    locked: false,
    entrants: [
      { player_id: 1, player_name: 'EG | Player One', seed_num: 1, live_odds: 1.5 },
      { player_id: 2, player_name: 'Player Two', seed_num: 2, live_odds: 3.2 },
    ],
  }],
  ['/api/game/1/6/players', { locked: false, entrants: [] }],
  ['/api/bets', []],
];

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('renders the tournament header, countdown, and the Outright panel by default', async () => {
  mockFetchRoutes(BASE_ROUTES);
  render(<WaitingRoom tournament={tournament} games={games} />);

  expect(screen.getByText('VSFighting XIV')).toBeInTheDocument();
  await waitFor(() => expect(screen.getByText('EG | Player One')).toBeInTheDocument());
  expect(screen.getByText('1.50×')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /outright/i })).toHaveAttribute('aria-selected', 'true');
});

test('tapping the Top 8 pill switches to the (still-empty) live bracket view', async () => {
  mockFetchRoutes(BASE_ROUTES);
  render(<WaitingRoom tournament={tournament} games={games} />);

  await waitFor(() => expect(screen.getByText('EG | Player One')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('tab', { name: /top 8/i }));

  // Bracket rendered with markets=[] waiting=true -> TBD placeholder nodes.
  expect(screen.getAllByText('TBD').length).toBeGreaterThan(0);
  expect(screen.queryByText('EG | Player One')).not.toBeInTheDocument();
});

test('switching game tabs refetches outright seeding for the newly selected game', async () => {
  mockFetchRoutes(BASE_ROUTES);
  render(<WaitingRoom tournament={tournament} games={games} />);

  await waitFor(() => expect(screen.getByText('EG | Player One')).toBeInTheDocument());

  fireEvent.click(screen.getByRole('tab', { name: /tekken 8/i }));

  // Tekken 8's /players route returns no entrants -> seeding-not-available copy.
  await waitFor(() => expect(screen.getByText('Seeding not available yet.')).toBeInTheDocument());
  expect(screen.queryByText('EG | Player One')).not.toBeInTheDocument();
});
