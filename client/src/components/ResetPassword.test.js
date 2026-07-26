import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ResetPassword from './ResetPassword';
import { renderWithRouter, mockFetchRoutes, setLoggedOut } from '../testUtils';

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('shows a "missing token" message when the URL has no ?token=', () => {
  renderWithRouter(<ResetPassword />, { route: '/reset-password' });

  expect(screen.getByText(/this reset link is missing its token/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /request a reset link/i })).toBeInTheDocument();
});

test('renders the form when a token is present', () => {
  renderWithRouter(<ResetPassword />, { route: '/reset-password?token=abc123' });

  expect(screen.getByText(/choose a new password/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/new password/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/confirm password/i)).toBeInTheDocument();
});

test('validates password length client-side before calling the API', async () => {
  renderWithRouter(<ResetPassword />, { route: '/reset-password?token=abc123' });
  const user = userEvent.setup();

  await user.type(screen.getByLabelText(/new password/i), 'short');
  await user.type(screen.getByLabelText(/confirm password/i), 'short');
  await user.click(screen.getByRole('button', { name: /update password/i }));

  expect(await screen.findByText(/password must be at least 8 characters/i)).toBeInTheDocument();
});

test('validates that the two passwords match before calling the API', async () => {
  renderWithRouter(<ResetPassword />, { route: '/reset-password?token=abc123' });
  const user = userEvent.setup();

  await user.type(screen.getByLabelText(/new password/i), 'longenough1');
  await user.type(screen.getByLabelText(/confirm password/i), 'longenough2');
  await user.click(screen.getByRole('button', { name: /update password/i }));

  expect(await screen.findByText(/passwords do not match/i)).toBeInTheDocument();
});

test('shows the server error message for an invalid or expired token', async () => {
  // mockFetchRoutes always resolves ok:true, so a non-2xx response needs to be
  // built by hand rather than via its response-table shape.
  global.fetch = jest.fn(() => Promise.resolve({
    ok: false,
    status: 400,
    json: async () => ({ error: 'This reset link is invalid or has expired.' }),
  }));

  renderWithRouter(<ResetPassword />, { route: '/reset-password?token=expiredtoken' });
  const user = userEvent.setup();

  await user.type(screen.getByLabelText(/new password/i), 'longenough1');
  await user.type(screen.getByLabelText(/confirm password/i), 'longenough1');
  await user.click(screen.getByRole('button', { name: /update password/i }));

  await waitFor(() => expect(screen.getByText(/this reset link is invalid or has expired/i)).toBeInTheDocument());
});

test('resets the password successfully and shows the "updated" confirmation', async () => {
  mockFetchRoutes([
    ['/api/auth/reset-password', { message: 'Your password has been updated. You can now log in.' }],
  ]);

  renderWithRouter(<ResetPassword />, { route: '/reset-password?token=validtoken' });
  const user = userEvent.setup();

  await user.type(screen.getByLabelText(/new password/i), 'longenough1');
  await user.type(screen.getByLabelText(/confirm password/i), 'longenough1');
  await user.click(screen.getByRole('button', { name: /update password/i }));

  await waitFor(() => expect(screen.getByText(/password updated/i)).toBeInTheDocument());
  expect(global.fetch).toHaveBeenCalledWith('/api/auth/reset-password', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ token: 'validtoken', newPassword: 'longenough1' }),
  }));
});
