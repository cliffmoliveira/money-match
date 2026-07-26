import { render, screen, act } from '@testing-library/react';
import Countdown from './Countdown';

// Countdown owns a real 1s setInterval and reads Date.now() itself, so these
// tests use fake timers throughout - both to control "now" and to advance
// the ticking without an actual 1s wall-clock wait.
beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-07-25T00:00:00.000Z'));
});

afterEach(() => {
  jest.useRealTimers();
});

test('renders nothing for a null/unparseable date', () => {
  const { container } = render(<Countdown date={null} />);
  expect(container).toBeEmptyDOMElement();
});

test('shows "Happening now" once the target time has passed', () => {
  render(<Countdown date="2026-07-24T00:00:00.000Z" />);
  expect(screen.getByText(/happening now/i)).toBeInTheDocument();
});

test('renders days/hrs/min/sec segments for a future date and ticks down each second', () => {
  // Exactly 1 day, 2 hours, 3 minutes, 4 seconds out.
  render(<Countdown date="2026-07-26T02:03:04.000Z" />);
  expect(screen.getByText('01')).toBeInTheDocument(); // Days
  expect(screen.getByText('02')).toBeInTheDocument(); // Hrs
  expect(screen.getByText('03')).toBeInTheDocument(); // Min
  expect(screen.getByText('04')).toBeInTheDocument(); // Sec

  act(() => {
    jest.advanceTimersByTime(1000);
  });
  // Min was already 3, and Sec has now also ticked down to 3, so there are
  // two "03" segments - the key assertion is that "04" (the old Sec value)
  // is gone.
  expect(screen.getAllByText('03')).toHaveLength(2);
  expect(screen.queryByText('04')).not.toBeInTheDocument();
});
