import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Follow from './Follow';
import { renderWithRouter, mockFetchRoutes, setLoggedIn, setLoggedOut } from '../testUtils';

const SEARCH_RESULT = { id: 42, name: 'LG CS3 VARS | MkLeo', photoUrl: null, latestActivity: 'Ultimate · CEO 2024' };
const FOLLOWED_PLAYER = {
  id: 42, name: 'LG CS3 VARS | MkLeo', country: 'US', photoUrl: null, followedAt: '2026-01-01',
  record: { wins: 10, losses: 2 }, tournamentCount: 3,
};

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('renders the empty-state message when nobody is followed yet', async () => {
  setLoggedIn();
  mockFetchRoutes([['/api/follows', []]]);

  renderWithRouter(<Follow />);

  await waitFor(() => expect(screen.getByText(/not following anyone yet/i)).toBeInTheDocument());
});

test('typing a search query shows results, and clicking Follow adds them to the followed list', async () => {
  setLoggedIn();
  let followedState = [];
  mockFetchRoutes([
    ['/api/players/search', [SEARCH_RESULT]],
    ['/api/follows', (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'POST') { followedState = [FOLLOWED_PLAYER]; return { ok: true }; }
      return followedState;
    }],
  ]);

  renderWithRouter(<Follow />);
  await waitFor(() => expect(screen.getByText(/not following anyone yet/i)).toBeInTheDocument());

  await userEvent.type(screen.getByPlaceholderText(/search competitors/i), 'Mk');
  // Search is debounced 250ms - give waitFor enough room past that.
  await waitFor(() => expect(screen.getByText('MkLeo')).toBeInTheDocument(), { timeout: 2000 });
  expect(screen.getByText('LG CS3 VARS')).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: /^follow$/i }));

  await waitFor(() => expect(screen.getByText('10-2')).toBeInTheDocument());
  expect(screen.queryByText(/not following anyone yet/i)).not.toBeInTheDocument();
});

test('clicking Unfollow removes a player from the followed list', async () => {
  setLoggedIn();
  let followedState = [FOLLOWED_PLAYER];
  mockFetchRoutes([
    ['/api/follows', (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      if (method === 'DELETE') { followedState = []; return { ok: true }; }
      return followedState;
    }],
  ]);

  renderWithRouter(<Follow />);
  await waitFor(() => expect(screen.getByText('MkLeo')).toBeInTheDocument());

  await userEvent.click(screen.getByRole('button', { name: /unfollow/i }));

  await waitFor(() => expect(screen.getByText(/not following anyone yet/i)).toBeInTheDocument());
});

test('expanding a followed player card loads and shows their tournament history', async () => {
  setLoggedIn();
  mockFetchRoutes([
    ['/api/follows', [FOLLOWED_PLAYER]],
    ['/api/players/42/profile', {
      player: { id: 42, name: 'LG CS3 VARS | MkLeo', country: 'US', photoUrl: null },
      record: { wins: 10, losses: 2 },
      tournaments: [
        { tournamentId: 1, tournamentName: 'CEO 2024', date: '2024-06-01', logoUrl: null, gameId: 1, gameName: 'Ultimate', placement: 1, result: 'Champion', partner: null },
      ],
    }],
  ]);

  renderWithRouter(<Follow />);
  await waitFor(() => expect(screen.getByText('MkLeo')).toBeInTheDocument());

  await userEvent.click(screen.getByText('MkLeo'));

  await waitFor(() => expect(screen.getByText('Champion')).toBeInTheDocument());
  expect(screen.getByText('CEO 2024')).toBeInTheDocument();
});
