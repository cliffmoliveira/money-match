import { screen, fireEvent, waitFor } from '@testing-library/react';
import LiveBetting from './LiveBetting';
import { mockFetchRoutes, setLoggedOut, renderWithRouter } from '../testUtils';

// LiveBetting.js has no react-router hooks of its own, so it's rendered
// directly (no renderWithRouter needed). It fetches ~6 endpoints on mount
// (config, live markets, wallet, live bets, upcoming, past-markets on a
// separate interval) plus, once a tournament/game is expanded, the tracker +
// outright-seeding endpoints for whichever game is active — every one of
// those has to be mocked or an unmocked 404 leaves a chunk of the page stuck
// in its empty/error branch instead of throwing.
const BASE_ROUTES = [
  ['/api/config', { demoEnabled: false }],
  ['/api/live/markets', []],
  ['/api/wallet', { balanceCents: 5000, transactions: [], dailyBonus: null, adReward: null }],
  ['/api/live/bets', []],
  ['/api/live/upcoming', []],
  ['/api/live/past-markets', []],
  ['/api/bets', []],
];

// One open Top-8 market shape, mirroring liveMarkets.getMarkets() (m.*, plus
// joined tournament_name/tournament_logo_url/.../game_name/player*_name).
const sf6Market = {
  id: 201, tournament_id: 10, game_id: 20,
  tournament_name: 'VSFighting XIV', tournament_logo_url: null, tournament_date: '2026-07-20',
  tournament_city: 'Orlando', tournament_country: 'US', tournament_num_entrants: 128,
  game_name: 'Street Fighter 6',
  round_text: 'Winners Final', round_int: 2, state: 'closed',
  player1_id: 1, player2_id: 2, player1_name: 'EG | Player One', player2_name: 'Player Two',
  p1_live_odds: 1.8, p2_live_odds: 2.2, p1_score: 1, p2_score: 0, winner_id: null,
};
const tekkenMarket = {
  ...sf6Market,
  id: 202, game_id: 21, game_name: 'Tekken 8',
  player1_id: 3, player2_id: 4, player1_name: 'Player Three', player2_name: 'Player Four',
  p1_live_odds: 1.5, p2_live_odds: 2.6, p1_score: null, p2_score: null, state: 'open',
};

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('renders the empty state when there are no live or upcoming markets', async () => {
  mockFetchRoutes(BASE_ROUTES);
  renderWithRouter(<LiveBetting />);

  await waitFor(() => expect(screen.getByText('No live markets right now')).toBeInTheDocument());
});

test('shows a live tournament under Happening Now, auto-expanded, with its bracket', async () => {
  mockFetchRoutes([
    ...BASE_ROUTES,
    ['/api/live/markets', [sf6Market]],
    ['/api/game/10/20/tracker', { rounds: [], results: [], stillAlive: [] }],
    ['/api/game/10/20/players', { locked: true, entrants: [] }],
  ]);
  renderWithRouter(<LiveBetting />);

  await waitFor(() => expect(screen.getByText('VSFighting XIV')).toBeInTheDocument());
  expect(screen.getByText('Happening Now')).toBeInTheDocument();
  // Auto-expanded because a 'closed' (in-progress) set exists, so its Top 8
  // bracket - defaulted to the Top 8 pill - is visible without any click.
  await waitFor(() => expect(screen.getByText('Player One')).toBeInTheDocument());
  expect(screen.getByText('Player Two')).toBeInTheDocument();
});

test('switching game tabs within a live tournament swaps the displayed bracket', async () => {
  mockFetchRoutes([
    ...BASE_ROUTES,
    ['/api/live/markets', [sf6Market, tekkenMarket]],
    ['/api/game/10/20/tracker', { rounds: [], results: [], stillAlive: [] }],
    ['/api/game/10/20/players', { locked: true, entrants: [] }],
    ['/api/game/10/21/tracker', { rounds: [], results: [], stillAlive: [] }],
    ['/api/game/10/21/players', { locked: false, entrants: [] }],
  ]);
  renderWithRouter(<LiveBetting />);

  await waitFor(() => expect(screen.getByText('Player One')).toBeInTheDocument());
  expect(screen.queryByText('Player Three')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: /tekken 8/i }));

  await waitFor(() => expect(screen.getByText('Player Three')).toBeInTheDocument());
  expect(screen.getByText('Player Four')).toBeInTheDocument();
  expect(screen.queryByText('Player One')).not.toBeInTheDocument();
});

test('tapping an open pick adds it to the slip and opens the drawer', async () => {
  mockFetchRoutes([
    ...BASE_ROUTES,
    ['/api/live/markets', [tekkenMarket]],
    ['/api/game/10/21/tracker', { rounds: [], results: [], stillAlive: [] }],
    ['/api/game/10/21/players', { locked: false, entrants: [] }],
  ]);
  renderWithRouter(<LiveBetting />);

  await waitFor(() => expect(screen.getByText('Player Three')).toBeInTheDocument());

  fireEvent.click(screen.getByText('Player Three').closest('button'));

  // Adding a pick auto-opens the drawer (slipOpen), which swaps the floating
  // "Slip (n)" tab for the full Live Slip panel showing the staged pick.
  expect(screen.getByText('Live Slip (1)')).toBeInTheDocument();
  expect(screen.queryByText(/tap a player's odds/i)).not.toBeInTheDocument();
});
