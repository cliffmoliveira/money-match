import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AffiliateHandoff from './AffiliateHandoff';
import { mockFetchRoutes } from '../testUtils';

const CONTEXT = {
  userId: 9014, book: 'mock_book', event_id: 'evo-2026', match_id: 'm-001',
  market_id: 'mk-sf6-outright', selection_id: 'sel-mena', participant_id: 'p-mena',
  source_page: 'match_detail',
};

afterEach(() => {
  jest.restoreAllMocks();
});

test('renders the default "Place on Mock Book" label', () => {
  render(<AffiliateHandoff context={CONTEXT} />);
  expect(screen.getByRole('button', { name: 'Place on Mock Book' })).toBeInTheDocument();
});

test('supports a custom label', () => {
  render(<AffiliateHandoff context={CONTEXT} label="Bet at DraftKings" />);
  expect(screen.getByRole('button', { name: 'Bet at DraftKings' })).toBeInTheDocument();
});

test('clicking POSTs the pick context to /api/affiliate/click and opens the returned deep link', async () => {
  const fetchMock = mockFetchRoutes([
    ['/api/affiliate/click', { click_id: 'clk_1', deep_link_url: 'https://mock-book.example/bet?click_id=clk_1' }],
  ]);
  const openSpy = jest.spyOn(window, 'open').mockImplementation(() => {});

  render(<AffiliateHandoff context={CONTEXT} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Place on Mock Book' }));

  // Wait for the button to leave its "Opening…" busy state too, so setBusy(false)
  // (the last state update in the click handler) settles before the test ends.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Place on Mock Book' })).toBeInTheDocument());
  expect(openSpy).toHaveBeenCalledWith('https://mock-book.example/bet?click_id=clk_1', '_blank', 'noopener');
  const [, opts] = fetchMock.mock.calls.find(([url]) => url.includes('/api/affiliate/click'));
  expect(opts.method).toBe('POST');
  expect(JSON.parse(opts.body)).toEqual(CONTEXT);
});

test('shows an error message and does not open a window when the click request fails', async () => {
  global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'missing event_id' }) }));
  const openSpy = jest.spyOn(window, 'open').mockImplementation(() => {});

  render(<AffiliateHandoff context={CONTEXT} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Place on Mock Book' }));

  await waitFor(() => expect(screen.getByText(/click failed \(400\)/i)).toBeInTheDocument());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Place on Mock Book' })).not.toBeDisabled());
  expect(openSpy).not.toHaveBeenCalled();
});
