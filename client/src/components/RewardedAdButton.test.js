import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RewardedAdButton from './RewardedAdButton';
import { mockFetchRoutes, setLoggedIn, setLoggedOut } from '../testUtils';

// showRewardedAd is the real ad-SDK seam (see utils/ads.js) - it builds a DOM
// overlay and resolves on a timer/skip click, which isn't what this component
// is responsible for. Mocking it lets these tests drive the actual behavior
// this component owns: calling the ad, then claiming the reward from the
// server and reflecting the result.
jest.mock('../utils/ads', () => ({
  showRewardedAd: jest.fn(),
  trackAdEvent: jest.fn(),
}));
const { showRewardedAd } = require('../utils/ads');

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('renders the "watch a video" label when off cooldown', () => {
  render(<RewardedAdButton />);
  expect(screen.getByRole('button', { name: /watch a video for \+25 fm/i })).toBeInTheDocument();
});

test('renders disabled with a countdown when a cooldown is already active', () => {
  render(<RewardedAdButton cooldownMs={5000} />);
  const button = screen.getByRole('button', { name: /watch again in 5s/i });
  expect(button).toBeDisabled();
});

test('clicking plays the ad, claims the reward, calls onReward with the new balance, and shows the credited amount', async () => {
  setLoggedIn({ userId: 9014 });
  showRewardedAd.mockResolvedValue({ completed: true });
  mockFetchRoutes([
    ['/api/wallet/ad-reward', { granted: true, amountCents: 2500, balanceCents: 10000, cooldownMs: 60000 }],
  ]);
  const onReward = jest.fn();

  render(<RewardedAdButton onReward={onReward} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /watch a video for \+25 fm/i }));

  await waitFor(() => expect(screen.getByText('+25 FM added!')).toBeInTheDocument());
  expect(showRewardedAd).toHaveBeenCalledWith({ placement: 'reward-popover' });
  expect(onReward).toHaveBeenCalledWith(10000);
  // Button goes onto the server-provided cooldown after a grant.
  expect(screen.getByRole('button', { name: /watch again in 60s/i })).toBeDisabled();
});

test('an unfinished ad (skipped) shows a nudge message and never calls the reward endpoint', async () => {
  setLoggedIn({ userId: 9014 });
  showRewardedAd.mockResolvedValue({ completed: false });
  const fetchMock = mockFetchRoutes([
    ['/api/wallet/ad-reward', { granted: true, amountCents: 2500, balanceCents: 10000, cooldownMs: 60000 }],
  ]);
  const onReward = jest.fn();

  render(<RewardedAdButton onReward={onReward} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /watch a video for \+25 fm/i }));

  await waitFor(() => expect(screen.getByText(/watch the full video to earn/i)).toBeInTheDocument());
  expect(onReward).not.toHaveBeenCalled();
  expect(fetchMock.mock.calledUrls.some((u) => u.includes('/api/wallet/ad-reward'))).toBe(false);
});

test('a 429 (still on server cooldown) sets the countdown from retryInMs and shows no credited message', async () => {
  setLoggedIn({ userId: 9014 });
  showRewardedAd.mockResolvedValue({ completed: true });
  global.fetch = jest.fn(() => Promise.resolve({
    ok: false, status: 429, json: async () => ({ granted: false, retryInMs: 30000 }),
  }));

  render(<RewardedAdButton />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /watch a video for \+25 fm/i }));

  await waitFor(() => expect(screen.getByRole('button', { name: /watch again in 30s/i })).toBeDisabled());
  expect(screen.queryByText(/added!/)).not.toBeInTheDocument();
});

test('counts the cooldown down each second and re-enables the button at zero', async () => {
  jest.useFakeTimers();
  render(<RewardedAdButton cooldownMs={2000} />);

  expect(screen.getByRole('button', { name: /watch again in 2s/i })).toBeDisabled();
  act(() => { jest.advanceTimersByTime(1000); });
  expect(screen.getByRole('button', { name: /watch again in 1s/i })).toBeDisabled();
  act(() => { jest.advanceTimersByTime(1000); });
  expect(screen.getByRole('button', { name: /watch a video for \+25 fm/i })).not.toBeDisabled();

  jest.useRealTimers();
});
