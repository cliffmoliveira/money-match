import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AdjustBetSheet from './AdjustBetSheet';
import { mockFetchRoutes, setLoggedIn, setLoggedOut } from '../testUtils';

// AdjustBetSheet.js only calls POST /api/bets (via apiFetch) - no GET routes
// to mock on mount. bet shape mirrors what LiveBetting/Home build for a
// Futures pick: tournamentId/gameId/playerId plus the current locked odds.
const bet = {
  tournamentId: 1,
  gameId: 2,
  playerId: 3,
  tournament: 'VSFighting XIV',
  game: 'Street Fighter 6',
  pick: 'EG | Player One',
  stake: 10,
  lockedOdds: 2,
  currentOdds: 2,
};

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('renders the current pick, stake, and payout', () => {
  setLoggedIn();
  mockFetchRoutes([]);
  render(<AdjustBetSheet bet={bet} onClose={() => {}} onSaved={() => {}} />);

  expect(screen.getByText('VSFighting XIV')).toBeInTheDocument();
  expect(screen.getByText('EG | Player One · Street Fighter 6')).toBeInTheDocument();
  expect(screen.getByLabelText('Pick stake')).toHaveValue(10);
  // 10 stake * 2 odds = 20 FM payout, unchanged from the current stake.
  expect(screen.getByText('20 FM')).toBeInTheDocument();
});

test('clicking the close button calls onClose', () => {
  setLoggedIn();
  mockFetchRoutes([]);
  const onClose = jest.fn();
  render(<AdjustBetSheet bet={bet} onClose={onClose} onSaved={() => {}} />);

  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('increasing the stake and saving posts the new amount and calls onSaved', async () => {
  setLoggedIn();
  const fetchMock = mockFetchRoutes([
    ['/api/bets', { message: 'ok' }],
  ]);
  const onSaved = jest.fn();
  render(<AdjustBetSheet bet={bet} onClose={() => {}} onSaved={onSaved} />);

  fireEvent.click(screen.getByRole('button', { name: 'Increase stake' }));
  expect(screen.getByLabelText('Pick stake')).toHaveValue(11);

  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, options] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  expect(JSON.parse(options.body)).toEqual({
    tournamentId: 1, gameId: 2, playerId: 3, amount: 11,
  });
});

test('the Save button stays disabled until the stake actually changes', () => {
  setLoggedIn();
  mockFetchRoutes([]);
  render(<AdjustBetSheet bet={bet} onClose={() => {}} onSaved={() => {}} />);

  expect(screen.getByRole('button', { name: 'Save changes' })).toBeDisabled();
});

test('confirming Cancel pick calls DELETE-equivalent POST with amount 0, then onSaved', async () => {
  setLoggedIn();
  const fetchMock = mockFetchRoutes([
    ['/api/bets', { message: 'ok' }],
  ]);
  const onSaved = jest.fn();
  render(<AdjustBetSheet bet={bet} onClose={() => {}} onSaved={onSaved} />);

  fireEvent.click(screen.getByRole('button', { name: 'Cancel pick' }));
  expect(screen.getByText('Remove this pick?')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Cancel pick' }));

  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  const [, options] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  expect(JSON.parse(options.body)).toEqual({
    tournamentId: 1, gameId: 2, playerId: 3, amount: 0,
  });
});
