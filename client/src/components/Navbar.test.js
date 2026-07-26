import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Navbar from './Navbar';
import { renderWithRouter, mockFetchRoutes, setLoggedIn, setLoggedOut } from '../testUtils';

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
  window.sessionStorage.clear();
});

test('shows a Login link and no wallet balance when logged out', async () => {
  setLoggedOut();
  mockFetchRoutes([
    ['/api/live/markets', []],
  ]);

  renderWithRouter(<Navbar isLoggedIn={false} />);

  await waitFor(() => expect(screen.getByRole('link', { name: /login/i })).toBeInTheDocument());
  expect(screen.queryByText(/FM$/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/account menu/i)).not.toBeInTheDocument();
});

test('shows the username, wallet balance, and nav links when logged in', async () => {
  setLoggedIn({ userId: 9014, username: 'DevTester' });
  mockFetchRoutes([
    ['/api/live/markets', []],
    ['/api/account?userId=9014', { avatar: null }],
    ['/api/wallet?userId=9014', {
      balanceCents: 100000,
      dailyBonus: { available: false, day: 3, amountCents: 7500, currentStreak: 2, ramp: [2500, 5000, 7500, 10000, 12500, 15000, 20000], nextAt: null },
      adReward: { available: false, retryInMs: 30000, amountCents: 2500, cooldownMs: 60000 },
    }],
  ]);

  renderWithRouter(<Navbar isLoggedIn={true} />);

  await waitFor(() => expect(screen.getByText('DevTester')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByText('1,000 FM')).toBeInTheDocument());
  // Rendered twice - once in the desktop link row, once in the mobile tab bar.
  expect(screen.getAllByRole('link', { name: /follow/i }).length).toBeGreaterThan(0);
  expect(screen.getByRole('button', { name: /account menu/i })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /^login$/i })).not.toBeInTheDocument();
});

test('claiming the daily reward calls the API and flips the popover to its claimed state', async () => {
  setLoggedIn({ userId: 9014, username: 'DevTester' });
  // Prevent the "auto-open once per session when a bonus is waiting" effect from
  // opening the popover on its own - otherwise our own click on the trigger
  // button would toggle it closed instead of open.
  window.sessionStorage.setItem('mm-reward-autoopened', '1');
  let claimed = false;
  mockFetchRoutes([
    ['/api/live/markets', []],
    ['/api/account?userId=9014', { avatar: null }],
    ['/api/wallet?userId=9014', () => ({
      balanceCents: 100000,
      dailyBonus: {
        available: !claimed, day: 1, amountCents: 2500, currentStreak: claimed ? 1 : 0,
        ramp: [2500, 5000, 7500, 10000, 12500, 15000, 20000], nextAt: null,
      },
      adReward: { available: true, retryInMs: 0, amountCents: 2500, cooldownMs: 60000 },
    })],
    ['/api/wallet/daily-bonus', () => {
      claimed = true;
      return { claimed: true, amountCents: 2500, streak: 1, balanceCents: 102500, nextAt: null };
    }],
  ]);

  renderWithRouter(<Navbar isLoggedIn={true} />);

  await waitFor(() => expect(screen.getByText(/daily reward/i)).toBeInTheDocument());
  await userEvent.click(screen.getByRole('button', { name: /daily reward/i }));

  const claimBtn = await screen.findByRole('button', { name: /claim \+25 fm/i });
  await userEvent.click(claimBtn);

  await waitFor(() => expect(screen.getByText(/claimed today/i)).toBeInTheDocument());
  expect(screen.getByText('1,025 FM')).toBeInTheDocument();
});
