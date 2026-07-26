import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AffiliateDemo from './AffiliateDemo';
import { mockFetchRoutes } from '../testUtils';

afterEach(() => {
  jest.restoreAllMocks();
  localStorage.removeItem('userId');
});

test('renders an editable field for every context key, prefilled with its default value', () => {
  render(<AffiliateDemo />);

  expect(screen.getByText(/affiliate handoff demo/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/event_id:/)).toHaveValue('evo-2026');
  expect(screen.getByLabelText(/match_id:/)).toHaveValue('m-001');
  expect(screen.getByLabelText(/market_id:/)).toHaveValue('mk-sf6-outright');
  expect(screen.getByLabelText(/selection_id:/)).toHaveValue('sel-mena');
  expect(screen.getByLabelText(/participant_id:/)).toHaveValue('p-mena');
  expect(screen.getByLabelText(/source_page:/)).toHaveValue('match_detail');
  // Renders the embedded AffiliateHandoff trigger.
  expect(screen.getByRole('button', { name: 'Place on Mock Book' })).toBeInTheDocument();
});

test('reads userId from localStorage into the initial context', () => {
  localStorage.setItem('userId', '4242');
  render(<AffiliateDemo />);
  // context.userId isn't itself an editable field, but it's what gets sent on
  // click - covered by the next test. This just confirms the page renders fine
  // when userId is present.
  expect(screen.getByRole('button', { name: 'Place on Mock Book' })).toBeInTheDocument();
});

test('editing a field and clicking through sends the updated context to /api/affiliate/click', async () => {
  localStorage.setItem('userId', '4242');
  const fetchMock = mockFetchRoutes([
    ['/api/affiliate/click', { click_id: 'clk_1', deep_link_url: 'https://mock-book.example/bet' }],
  ]);
  jest.spyOn(window, 'open').mockImplementation(() => {});

  render(<AffiliateDemo />);
  const user = userEvent.setup();
  const eventIdInput = screen.getByLabelText(/event_id:/);
  await user.clear(eventIdInput);
  await user.type(eventIdInput, 'frosty-2026');
  await user.click(screen.getByRole('button', { name: 'Place on Mock Book' }));

  await waitFor(() => {
    const call = fetchMock.mock.calls.find(([url]) => url.includes('/api/affiliate/click'));
    expect(call).toBeTruthy();
  });
  const [, opts] = fetchMock.mock.calls.find(([url]) => url.includes('/api/affiliate/click'));
  const body = JSON.parse(opts.body);
  expect(body.event_id).toBe('frosty-2026');
  expect(body.userId).toBe(4242);
  expect(body.book).toBe('mock_book');
  expect(body.source_page).toBe('match_detail');
});
