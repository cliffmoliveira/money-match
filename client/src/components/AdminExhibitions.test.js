import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AdminExhibitions from './AdminExhibitions';
import { mockFetchRoutes } from '../testUtils';

const SECRET_KEY = 'mm-admin-secret';

afterEach(() => {
  jest.restoreAllMocks();
  sessionStorage.removeItem(SECRET_KEY);
});

test('shows the secret gate when no admin secret is stored yet', () => {
  render(<AdminExhibitions />);

  expect(screen.getByText('Admin')).toBeInTheDocument();
  expect(screen.getByPlaceholderText('Admin secret')).toBeInTheDocument();
  expect(screen.queryByText('Create exhibition')).not.toBeInTheDocument();
});

test('submitting the secret sends it as the x-admin-secret header on /api/admin/exhibitions', async () => {
  const fetchMock = mockFetchRoutes([
    ['/api/admin/exhibitions', []],
  ]);

  render(<AdminExhibitions />);
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('Admin secret'), 'sup3r-secret');
  await user.click(screen.getByRole('button', { name: 'Enter' }));

  await waitFor(() => expect(screen.getByText('No exhibitions yet.')).toBeInTheDocument());
  const [, opts] = fetchMock.mock.calls.find(([url]) => url.includes('/api/admin/exhibitions'));
  expect(opts.headers['x-admin-secret']).toBe('sup3r-secret');
  expect(sessionStorage.getItem(SECRET_KEY)).toBe('sup3r-secret');
});

test('a rejected secret (403) clears storage and shows an auth error instead of the admin panel', async () => {
  global.fetch = jest.fn(() => Promise.resolve({
    ok: false, status: 403, json: async () => ({ error: 'Forbidden' }),
  }));

  render(<AdminExhibitions />);
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('Admin secret'), 'wrong-secret');
  await user.click(screen.getByRole('button', { name: 'Enter' }));

  await waitFor(() => expect(screen.getByText('That secret was rejected.')).toBeInTheDocument());
  expect(sessionStorage.getItem(SECRET_KEY)).toBeNull();
  // Still on the gate, not the admin panel.
  expect(screen.getByPlaceholderText('Admin secret')).toBeInTheDocument();
});

test('with a valid secret already stored, lists existing exhibitions and lets an operator create a new one', async () => {
  sessionStorage.setItem(SECRET_KEY, 'good-secret');
  const fetchMock = mockFetchRoutes([
    // '/api/admin/exhibition' (create) is a substring of '/api/admin/exhibitions'
    // (list), so both need exact-anchored RegExps rather than plain substrings.
    [/\/api\/admin\/exhibitions$/, [
      { id: 1, state: 'pending', player1_name: 'Punk', player2_name: 'MenaRD', game_name: 'SF6', tournament_name: 'Evo', event_date: '2026-08-01' },
    ]],
    [/\/api\/admin\/exhibition$/, { id: 2 }],
  ]);

  render(<AdminExhibitions />);

  await waitFor(() => expect(screen.getByText('Punk vs MenaRD')).toBeInTheDocument());
  expect(screen.getByText('pending')).toBeInTheDocument();
  expect(screen.getByText('Open for picks')).toBeInTheDocument();

  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('Player 1'), 'Tokido');
  await user.type(screen.getByPlaceholderText('Player 2'), 'NuckleDu');
  await user.click(screen.getByRole('button', { name: /create exhibition/i }));

  // Wait for the full round trip to settle - the button only reverts from
  // "Creating…" back to its resting label after the POST, the reload it
  // triggers, and setCreating(false) have all resolved - so no state update
  // lands after the test's own act() scope closes.
  await waitFor(() => expect(screen.getByRole('button', { name: /^create exhibition$/i })).toBeInTheDocument());
  const [, createOpts] = fetchMock.mock.calls.find(([url, opts]) => url.includes('/api/admin/exhibition') && opts?.method === 'POST');
  expect(createOpts.headers['x-admin-secret']).toBe('good-secret');
  const body = JSON.parse(createOpts.body);
  expect(body.player1_name).toBe('Tokido');
  expect(body.player2_name).toBe('NuckleDu');
});
