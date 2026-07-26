import { screen, waitFor } from '@testing-library/react';
import Home from './Home';
import { renderWithRouter, mockFetchRoutes, setLoggedIn, setLoggedOut } from '../testUtils';

// Every fetch Home.js makes unconditionally on mount, regardless of login
// state - a test that only mocks the ones it "cares about" would otherwise
// hang forever on the rest (see mockFetchRoutes' unmocked-route 404 behavior).
const BASE_ROUTES = [
  ['/api/tournaments/all', []],
  ['/api/tournaments', []],
  ['/api/past-results', { data: [] }],
  ['/api/games', []],
  ['/api/players', []],
  ['/api/live/markets', []],
  ['/api/live/upcoming', []],
];

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('renders the logged-out value-prop hero', async () => {
  setLoggedOut();
  mockFetchRoutes(BASE_ROUTES);

  renderWithRouter(<Home />);

  await waitFor(() => expect(screen.getByText(/pick winners in the fgc/i)).toBeInTheDocument());
  expect(screen.getByRole('link', { name: /sign up free/i })).toBeInTheDocument();
});

test('shows the "in progress" hero for a live tournament from /api/live/upcoming, even with no open sets yet', async () => {
  // Regression test for a real bug: getUpcoming() returns an array of
  // { tournament, games } pairs (one per tracked tournament), not a single
  // pair - Home.js used to destructure it as a single object, so
  // liveActiveTournament could never populate and this hero state was dead
  // code. Mirrors the exact shape /api/live/upcoming actually returns.
  setLoggedIn({ userId: 9014 });
  mockFetchRoutes([
    ...BASE_ROUTES,
    ['/api/live/upcoming', [
      { tournament: { id: 1, name: 'Not Live Major', isLive: 0, logoUrl: null }, games: [] },
      { tournament: { id: 2, name: 'VSFighting XIV', isLive: 1, logoUrl: null }, games: [] },
    ]],
    ['/api/bets?userId=9014', []],
    ['/api/live/bets?userId=9014', []],
    ['/api/pickem/profile', { rank: 1, points: 0 }],
  ]);

  renderWithRouter(<Home />);

  await waitFor(() => expect(screen.getByText('VSFighting XIV')).toBeInTheDocument());
  expect(screen.getByText(/in progress/i)).toBeInTheDocument();
  // The non-live tournament in the same response must not be the one shown.
  expect(screen.queryByText('Not Live Major')).not.toBeInTheDocument();
});
