import { render, screen, fireEvent } from '@testing-library/react';
import TournamentFilterBar from './TournamentFilterBar';

const baseValue = { year: 'all', tournament: 'all', game: 'all' };

test('renders the toggle and results count, with the filter panel closed by default', () => {
  render(
    <TournamentFilterBar
      years={['2025', '2026']}
      tournaments={['VSFighting XIV']}
      games={['Street Fighter 6']}
      value={baseValue}
      onChange={() => {}}
      onClear={() => {}}
      resultsCount={12}
    />
  );

  expect(screen.getByRole('button', { name: /filters/i })).toBeInTheDocument();
  expect(screen.getByText('12 results')).toBeInTheDocument();
  expect(screen.queryByLabelText('Year')).not.toBeInTheDocument();
});

test('opening the panel and picking a year calls onChange with the full next value', () => {
  const onChange = jest.fn();
  render(
    <TournamentFilterBar
      years={['2025', '2026']}
      tournaments={[]}
      games={[]}
      value={baseValue}
      onChange={onChange}
      onClear={() => {}}
      resultsCount={0}
    />
  );

  fireEvent.click(screen.getByRole('button', { name: /filters/i }));
  fireEvent.change(screen.getByLabelText('Year'), { target: { value: '2026' } });

  expect(onChange).toHaveBeenCalledWith({ year: '2026', tournament: 'all', game: 'all' });
});

test('shows a removable chip and a count badge for each active filter, and clears them', () => {
  const onChange = jest.fn();
  const onClear = jest.fn();
  render(
    <TournamentFilterBar
      years={['2025', '2026']}
      tournaments={['VSFighting XIV']}
      games={['Street Fighter 6']}
      value={{ year: '2026', tournament: 'all', game: 'Street Fighter 6' }}
      onChange={onChange}
      onClear={onClear}
      resultsCount={3}
    />
  );

  // Count badge reflects the two active filters (year + game).
  const toggle = screen.getByRole('button', { name: /filters/i });
  expect(toggle).toHaveTextContent('2');

  // Chips' accessible name comes from their visible text ("2026"), not the
  // `title` tooltip attribute ("Remove 2026") - look them up by title instead.
  expect(screen.getByTitle('Remove 2026')).toBeInTheDocument();
  expect(screen.getByTitle('Remove Street Fighter 6')).toBeInTheDocument();

  // Clicking a chip clears just that one field.
  fireEvent.click(screen.getByTitle('Remove 2026'));
  expect(onChange).toHaveBeenCalledWith({ year: 'all', tournament: 'all', game: 'Street Fighter 6' });

  // Opening the panel reveals the "Clear" button, which calls onClear.
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
  expect(onClear).toHaveBeenCalledTimes(1);
});
