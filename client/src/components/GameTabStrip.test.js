import { render, screen, fireEvent } from '@testing-library/react';
import GameTabStrip from './GameTabStrip';

const tabs = [
  { key: 'sf6', gameName: 'Street Fighter 6', isLive: true, isSettled: false, winner: null },
  { key: 'ggst', gameName: 'Guilty Gear Strive', isLive: false, isSettled: true, winner: 'PlayerOne' },
];

test('renders one tab per game and marks the active one', () => {
  render(<GameTabStrip tabs={tabs} activeKey="sf6" onSelect={() => {}} />);

  const activeTab = screen.getByRole('tab', { name: /street fighter 6/i });
  expect(activeTab).toHaveAttribute('aria-selected', 'true');
  expect(activeTab).toHaveClass('active');
});

test('shows a LIVE badge for a live game and a winner badge for a settled one', () => {
  render(<GameTabStrip tabs={tabs} activeKey="sf6" onSelect={() => {}} />);

  const liveTab = screen.getByRole('tab', { name: /street fighter 6/i });
  expect(liveTab).toHaveTextContent('LIVE');
  expect(liveTab).not.toHaveClass('settled');

  const settledTab = screen.getByRole('tab', { name: /guilty gear strive/i });
  expect(settledTab).toHaveClass('settled');
  expect(settledTab).toHaveTextContent('PlayerOne');
  expect(settledTab).not.toHaveTextContent('LIVE');
});

test('clicking an inactive tab calls onSelect with its key', () => {
  const onSelect = jest.fn();
  render(<GameTabStrip tabs={tabs} activeKey="sf6" onSelect={onSelect} />);

  fireEvent.click(screen.getByRole('tab', { name: /guilty gear strive/i }));
  expect(onSelect).toHaveBeenCalledWith('ggst');
});

test('falls back to the game name as text once every candidate logo asset fails to load', () => {
  // getGameLogoSources() always produces at least one candidate URL (a
  // slugified guess), so GameLogo renders an <img> first and only falls
  // back to plain text after that image (and any other candidates) fire
  // onError - simulate that exhausting.
  render(<GameTabStrip tabs={[{ key: 'x', gameName: 'Some Unknown Game', isLive: false, isSettled: false }]} activeKey="x" onSelect={() => {}} />);

  let img = screen.getByRole('img');
  // Keep firing error until every candidate is exhausted and it falls back to text.
  for (let i = 0; i < 10 && img; i++) {
    fireEvent.error(img);
    img = screen.queryByRole('img');
  }

  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(screen.getByText('Some Unknown Game')).toBeInTheDocument();
});
