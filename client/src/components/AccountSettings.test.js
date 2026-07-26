import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AccountSettings from './AccountSettings';
import { renderWithRouter, mockFetchRoutes, setLoggedIn, setLoggedOut } from '../testUtils';

const ACCOUNT = {
  username: 'fgcfan', email: 'fan@example.com',
  display_name: 'FGC Fan', full_name: '', birthday: '', gender: '', pronouns: '',
  country: '', team: '', favorite_game: '', main_character: '', bio: '',
  twitch: '', twitter: '', discord: '', avatar: '', timezone: 'America/New_York',
};

const BASE_ROUTES = [
  [/\/api\/account\?userId=/, ACCOUNT],
];

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('loads and renders the account form', async () => {
  setLoggedIn({ userId: 9014 });
  mockFetchRoutes(BASE_ROUTES);

  renderWithRouter(<AccountSettings />);

  expect(screen.getByText(/loading your account/i)).toBeInTheDocument();
  await waitFor(() => expect(screen.getByDisplayValue('FGC Fan')).toBeInTheDocument());
  expect(screen.getByText(/@fgcfan/i)).toBeInTheDocument();
});

test('requires a display name before saving', async () => {
  setLoggedIn({ userId: 9014 });
  mockFetchRoutes(BASE_ROUTES);

  renderWithRouter(<AccountSettings />);
  await waitFor(() => expect(screen.getByDisplayValue('FGC Fan')).toBeInTheDocument());

  const user = userEvent.setup();
  await user.clear(screen.getByDisplayValue('FGC Fan'));
  await user.click(screen.getByRole('button', { name: /save changes/i }));

  expect(await screen.findByText(/display name is required/i)).toBeInTheDocument();
});

test('saves profile changes and updates the stored username', async () => {
  setLoggedIn({ userId: 9014 });
  mockFetchRoutes([
    ...BASE_ROUTES,
    [/\/api\/account$/, () => ({ ...ACCOUNT, display_name: 'New Name' })],
  ]);

  renderWithRouter(<AccountSettings />);
  await waitFor(() => expect(screen.getByDisplayValue('FGC Fan')).toBeInTheDocument());

  const user = userEvent.setup();
  const nameInput = screen.getByDisplayValue('FGC Fan');
  await user.clear(nameInput);
  await user.type(nameInput, 'New Name');
  await user.click(screen.getByRole('button', { name: /save changes/i }));

  await waitFor(() => expect(screen.getByText(/saved — your profile is up to date/i)).toBeInTheDocument());
  expect(localStorage.getItem('username')).toBe('New Name');
});

test('shows the server error message when saving fails', async () => {
  setLoggedIn({ userId: 9014 });
  // mockFetchRoutes always resolves ok:true, so the PUT's non-2xx response
  // needs to be built by hand, keyed off the request method.
  global.fetch = jest.fn((url, opts) => {
    if (opts && opts.method === 'PUT') {
      return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'Display name must be at least 2 characters.' }) });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ACCOUNT });
  });

  renderWithRouter(<AccountSettings />);
  await waitFor(() => expect(screen.getByDisplayValue('FGC Fan')).toBeInTheDocument());

  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /save changes/i }));

  await waitFor(() => expect(screen.getByText(/display name must be at least 2 characters/i)).toBeInTheDocument());
});

test('validates the new password fields before calling the API', async () => {
  setLoggedIn({ userId: 9014 });
  mockFetchRoutes(BASE_ROUTES);

  renderWithRouter(<AccountSettings />);
  await waitFor(() => expect(screen.getByDisplayValue('FGC Fan')).toBeInTheDocument());

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/current password/i), 'oldpassword');
  await user.type(screen.getByLabelText(/^new password$/i), 'short');
  await user.type(screen.getByLabelText(/confirm new password/i), 'short');
  await user.click(screen.getByRole('button', { name: /update password/i }));

  expect(await screen.findByText(/new password must be at least 8 characters/i)).toBeInTheDocument();
});

test('changes the password successfully', async () => {
  setLoggedIn({ userId: 9014 });
  mockFetchRoutes([
    ...BASE_ROUTES,
    ['/api/account/password', { message: 'Your password has been updated.' }],
  ]);

  renderWithRouter(<AccountSettings />);
  await waitFor(() => expect(screen.getByDisplayValue('FGC Fan')).toBeInTheDocument());

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/current password/i), 'oldpassword');
  await user.type(screen.getByLabelText(/^new password$/i), 'newpassword1');
  await user.type(screen.getByLabelText(/confirm new password/i), 'newpassword1');
  await user.click(screen.getByRole('button', { name: /update password/i }));

  await waitFor(() => expect(screen.getByText(/password updated/i)).toBeInTheDocument());
  expect(global.fetch).toHaveBeenCalledWith('/api/account/password', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ currentPassword: 'oldpassword', newPassword: 'newpassword1' }),
  }));
});
