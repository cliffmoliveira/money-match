import { screen, waitFor } from '@testing-library/react';
import Profile from './Profile';
import { renderWithRouter, mockFetchRoutes, setLoggedIn, setLoggedOut } from '../testUtils';

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('shows "Not logged in" when there is no userId in localStorage', async () => {
  setLoggedOut();
  mockFetchRoutes([]);

  renderWithRouter(<Profile />);

  await waitFor(() => expect(screen.getByText(/not logged in/i)).toBeInTheDocument());
});

test('shows the empty-state prompt when the user has no picks yet', async () => {
  setLoggedIn({ userId: 9014 });
  mockFetchRoutes([
    ['/api/live/bets?userId=9014', []],
  ]);

  renderWithRouter(<Profile />);

  await waitFor(() => expect(screen.getByText(/no picks yet/i)).toBeInTheDocument());
  // Stats row still renders with zeroed-out values.
  expect(screen.getByText('Wins')).toBeInTheDocument();
  expect(screen.getByText('0%')).toBeInTheDocument();
});

test('renders computed stats and pick history rows from live bets', async () => {
  setLoggedIn({ userId: 9014 });
  mockFetchRoutes([
    ['/api/live/bets?userId=9014', [
      {
        id: 1, state: 'won', amount_cents: 1000, payout_cents: 1800, locked_odds: 1.8,
        picked_name: 'MkLeo', player1_name: 'MkLeo', player2_name: 'Tweek',
        tournament_name: 'CEO 2024', game_name: 'Ultimate', round_text: 'Winners Final',
      },
      {
        id: 2, state: 'lost', amount_cents: 500, payout_cents: 0, locked_odds: 2.1,
        picked_name: 'Tweek', player1_name: 'MkLeo', player2_name: 'Tweek',
        tournament_name: 'CEO 2024', game_name: 'Ultimate', round_text: 'Grand Final',
      },
    ]],
  ]);

  renderWithRouter(<Profile />);

  await waitFor(() => expect(screen.getByText('Pick history')).toBeInTheDocument());
  // Stats: 1 win, 1 loss, 50% accuracy, net = (1800-1000) - 500 = 300 -> "+3"
  expect(screen.getByText('+3')).toBeInTheDocument();
  expect(screen.getByText('50%')).toBeInTheDocument();
  expect(screen.getByText('WON')).toBeInTheDocument();
  expect(screen.getByText('LOST')).toBeInTheDocument();
  expect(screen.getAllByText('MkLeo').length).toBeGreaterThan(0);
  expect(screen.getAllByText('Tweek').length).toBeGreaterThan(0);
});
