import { render, screen } from '@testing-library/react';
import GameTracker from './GameTracker';

// GameTracker.js has no fetch calls of its own — it's a pure presentational
// component driven by `seeds`/`results`/`roundLabel` props (owned by
// WaitingRoom.js / LiveBetting.js, which fetch /api/game/:t/:g/tracker).

const results = [
  { winner: 'EG | Player One', loser: 'Player Two', winnerScore: 3, loserScore: 1, round: 'Round of 16' },
  { winner: 'Player Three', loser: 'Player Four', winnerScore: 3, loserScore: 2, round: 'Round of 8' },
];

const seeds = [
  { seed: 1, name: 'Player Five' },
  { seed: 2, name: 'Player Three' },
];

test('renders only the results matching roundLabel, plus the still-alive seed list', () => {
  render(<GameTracker seeds={seeds} results={results} roundLabel="Round of 16" />);

  expect(screen.getByText('Round of 16 results')).toBeInTheDocument();
  expect(screen.getByText('Player One')).toBeInTheDocument();
  expect(screen.getByText('Player Two')).toBeInTheDocument();
  // The Round of 8 result shouldn't leak into a Round of 16 view.
  expect(screen.queryByText('Player Four')).not.toBeInTheDocument();

  expect(screen.getByText('Still alive (current)')).toBeInTheDocument();
  expect(screen.getByText('Player Five')).toBeInTheDocument();
});

test('shows an empty-state message when there are no results or seeds yet', () => {
  render(<GameTracker seeds={[]} results={[]} roundLabel="Pools" />);

  expect(screen.getByText('No results tracked for this round yet.')).toBeInTheDocument();
  expect(screen.getByText('Seeding not available yet.')).toBeInTheDocument();
});
