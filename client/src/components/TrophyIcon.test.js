import { render } from '@testing-library/react';
import TrophyIcon from './TrophyIcon';

// Pure presentational SVG icon, no fetches, no state - a render smoke test
// plus a check that `className` is actually forwarded onto the <svg> is all
// there is to meaningfully cover here.

test('renders an svg with no props', () => {
  const { container } = render(<TrophyIcon />);
  const svg = container.querySelector('svg');
  expect(svg).toBeInTheDocument();
  expect(svg).toHaveAttribute('aria-hidden', 'true');
});

test('forwards className onto the svg element', () => {
  const { container } = render(<TrophyIcon className="live-tab-winner-star" />);
  const svg = container.querySelector('svg');
  expect(svg).toHaveClass('live-tab-winner-star');
});
