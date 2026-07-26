import { render, screen, fireEvent } from '@testing-library/react';
import OutrightPanel from './OutrightPanel';

// OutrightPanel.js has no fetch calls of its own — driven entirely by props
// owned by useOutrightPicks (shared between WaitingRoom and TrackerPanel).

const seedRows = [
  { player_id: 1, player_name: 'EG | Player One', seed_num: 1, live_odds: 1.5 },
  { player_id: 2, player_name: 'Player Two', seed_num: 2, live_odds: 3.2 },
];

test('renders seed rows with odds, and clicking an unlocked row calls onPick', () => {
  const onPick = jest.fn();
  render(<OutrightPanel seedRows={seedRows} locked={false} slip={{}} myPicks={{}} onPick={onPick} />);

  expect(screen.getByText('EG | Player One')).toBeInTheDocument();
  expect(screen.getByText('1.50×')).toBeInTheDocument();
  expect(screen.getByText('3.20×')).toBeInTheDocument();

  fireEvent.click(screen.getByText('EG | Player One'));
  expect(onPick).toHaveBeenCalledWith(seedRows[0]);
});

test('shows the "Your Pick" badge for a confirmed pick when highlight is true', () => {
  render(
    <OutrightPanel
      seedRows={seedRows}
      locked={true}
      slip={{}}
      myPicks={{ 1: { amount: 10, lockedOdds: 1.5 } }}
      onPick={() => {}}
      highlight
    />
  );

  expect(screen.getByText('Your Pick')).toBeInTheDocument();
  expect(screen.getByText('Picks are locked — no changes once the bracket begins.')).toBeInTheDocument();
});

test('disables rows and shows the seeded-only note once locked with no picks', () => {
  render(<OutrightPanel seedRows={seedRows} locked={true} slip={{}} myPicks={{}} onPick={() => {}} />);

  const row = screen.getByText('EG | Player One').closest('button');
  expect(row).toBeDisabled();
  expect(screen.getByText(/outright picks are closed/i)).toBeInTheDocument();
});

test('shows the seeding-not-available message when there are no seed rows', () => {
  render(<OutrightPanel seedRows={[]} locked={false} slip={{}} myPicks={{}} onPick={() => {}} />);

  expect(screen.getByText('Seeding not available yet.')).toBeInTheDocument();
});
