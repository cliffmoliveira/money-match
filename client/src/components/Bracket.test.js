import { render, screen, fireEvent } from '@testing-library/react';
import Bracket from './Bracket';

// Bracket.js has no fetch calls of its own — it's a pure presentational
// component driven entirely by the `markets` prop, so these tests render it
// directly (no renderWithRouter/mockFetchRoutes needed) with realistic
// set_markets rows, matching the shape returned by liveMarkets.getMarkets()
// (m.*, plus joined player1_name/player2_name).

const openMarket = {
  id: 101,
  tournament_id: 1,
  game_id: 1,
  round_text: 'Winners Final',
  round_int: 2,
  state: 'open',
  player1_id: 1,
  player2_id: 2,
  player1_name: 'EG | Player One',
  player2_name: 'Player Two',
  p1_live_odds: 1.8,
  p2_live_odds: 2.2,
  p1_score: null,
  p2_score: null,
  winner_id: null,
};

const settledMarket = {
  id: 102,
  tournament_id: 1,
  game_id: 1,
  round_text: 'Grand Final',
  round_int: 7,
  state: 'settled',
  player1_id: 1,
  player2_id: 3,
  player1_name: 'EG | Player One',
  player2_name: 'Player Three',
  p1_score: 3,
  p2_score: 1,
  winner_id: 1,
};

test('renders player names and odds for an open market', () => {
  render(<Bracket markets={[openMarket]} onPick={() => {}} />);

  expect(screen.getByText('Player One')).toBeInTheDocument();
  expect(screen.getByText('Player Two')).toBeInTheDocument();
  expect(screen.getByText('1.80')).toBeInTheDocument();
  expect(screen.getByText('2.20')).toBeInTheDocument();
});

test('renders scores and champion trophy for a settled Grand Final market', () => {
  render(<Bracket markets={[settledMarket]} onPick={() => {}} />);

  expect(screen.getByText('Player One')).toBeInTheDocument();
  expect(screen.getByText('Player Three')).toBeInTheDocument();
  expect(screen.getByText('3')).toBeInTheDocument();
  expect(screen.getByText('1')).toBeInTheDocument();
});

test('clicking an open row calls onPick with the market and player id', () => {
  const onPick = jest.fn();
  render(<Bracket markets={[openMarket]} onPick={onPick} />);

  fireEvent.click(screen.getByText('Player One').closest('button'));

  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onPick).toHaveBeenCalledWith(openMarket, 1);
});

test('does not call onPick when clicking a settled (non-open) row', () => {
  const onPick = jest.fn();
  render(<Bracket markets={[settledMarket]} onPick={onPick} />);

  fireEvent.click(screen.getByText('Player One').closest('button'));

  expect(onPick).not.toHaveBeenCalled();
});
