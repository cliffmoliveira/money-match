import { screen, waitFor } from '@testing-library/react';
import Leaderboard from './Leaderboard';
import { renderWithRouter, mockFetchRoutes, setLoggedIn, setLoggedOut } from '../testUtils';

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('shows the empty-state message when nobody has scored picks yet', async () => {
  mockFetchRoutes([
    ['/api/pickem/leaderboard', []],
  ]);

  renderWithRouter(<Leaderboard />);

  await waitFor(() => expect(screen.getByText(/no picks scored yet/i)).toBeInTheDocument());
});

test('renders a ranked list of users with their FM, accuracy, and streak', async () => {
  setLoggedIn({ userId: 9014 });
  mockFetchRoutes([
    ['/api/pickem/leaderboard', [
      { rank: 1, user_id: 5, username: 'TopDog', avatar: null, balance_cents: 500000, accuracy: 0.82, best_streak: 12 },
      { rank: 2, user_id: 9014, username: 'DevTester', avatar: null, balance_cents: 250000, accuracy: 0.6, best_streak: 4 },
    ]],
  ]);

  renderWithRouter(<Leaderboard />);

  await waitFor(() => expect(screen.getByText('TopDog')).toBeInTheDocument());
  expect(screen.getByText('DevTester')).toBeInTheDocument();
  expect(screen.getByText('82%')).toBeInTheDocument();
  expect(screen.getByText('60%')).toBeInTheDocument();
  expect(screen.getByText('12')).toBeInTheDocument();

  // The logged-in user's own row is highlighted with the "me" class.
  const myRow = screen.getByText('DevTester').closest('.lb-row');
  expect(myRow).toHaveClass('me');
  const otherRow = screen.getByText('TopDog').closest('.lb-row');
  expect(otherRow).not.toHaveClass('me');
});

test('shows an error message when the leaderboard fails to load', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }));

  renderWithRouter(<Leaderboard />);

  await waitFor(() => expect(screen.getByText(/failed to load leaderboard/i)).toBeInTheDocument());
});
