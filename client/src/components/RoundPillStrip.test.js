import { render, screen, fireEvent } from '@testing-library/react';
import RoundPillStrip from './RoundPillStrip';

const rounds = [
  { roundText: 'Pools', status: 'completed' },
  { roundText: 'Round 1', status: 'completed' },
  { roundText: 'Top 8', status: 'active' },
];

test('renders one tab per round and marks the selected one', () => {
  render(<RoundPillStrip rounds={rounds} selected="Top 8" onSelect={() => {}} />);

  const tabs = screen.getAllByRole('tab');
  expect(tabs).toHaveLength(3);

  const selectedTab = screen.getByRole('tab', { name: /top 8/i });
  expect(selectedTab).toHaveAttribute('aria-selected', 'true');
  expect(selectedTab).toHaveClass('selected');

  const otherTab = screen.getByRole('tab', { name: /pools/i });
  expect(otherTab).toHaveAttribute('aria-selected', 'false');
  expect(otherTab).not.toHaveClass('selected');
});

test('clicking a pill calls onSelect with that round', () => {
  const onSelect = jest.fn();
  render(<RoundPillStrip rounds={rounds} selected="Top 8" onSelect={onSelect} />);

  fireEvent.click(screen.getByRole('tab', { name: /round 1/i }));
  expect(onSelect).toHaveBeenCalledWith(rounds[1]);
});

test('scroll arrows are hidden when the strip does not overflow', () => {
  // jsdom reports scrollWidth/clientWidth as 0 for every element, so
  // useScrollEdges' canScrollLeft/canScrollRight both resolve false here.
  render(<RoundPillStrip rounds={rounds} selected="Pools" onSelect={() => {}} />);
  expect(screen.queryByLabelText('Scroll left')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Scroll right')).not.toBeInTheDocument();
});
