import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ForgotPassword from './ForgotPassword';
import { renderWithRouter, mockFetchRoutes, setLoggedOut } from '../testUtils';

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('renders the forgot-password form', () => {
  renderWithRouter(<ForgotPassword />);

  expect(screen.getByText(/reset your password/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
});

test('shows the server error message on failure', async () => {
  // mockFetchRoutes always resolves ok:true, so a non-2xx response needs to be
  // built by hand rather than via its response-table shape.
  global.fetch = jest.fn(() => Promise.resolve({
    ok: false,
    status: 500,
    json: async () => ({ error: 'Could not process the request.' }),
  }));

  renderWithRouter(<ForgotPassword />);
  const user = userEvent.setup();

  await user.type(screen.getByLabelText(/email/i), 'someone@example.com');
  await user.click(screen.getByRole('button', { name: /send reset link/i }));

  await waitFor(() => expect(screen.getByText(/could not process the request/i)).toBeInTheDocument());
});

test('submits successfully and shows the generic "check your inbox" note, even for an unknown email', async () => {
  // The endpoint always returns the same generic 200 response regardless of
  // whether the email exists, so it can't be used to probe registered emails.
  mockFetchRoutes([
    ['/api/auth/forgot-password', { message: 'If an account exists for that email, a password reset link has been sent.' }],
  ]);

  renderWithRouter(<ForgotPassword />);
  const user = userEvent.setup();

  await user.type(screen.getByLabelText(/email/i), 'someone@example.com');
  await user.click(screen.getByRole('button', { name: /send reset link/i }));

  await waitFor(() => expect(screen.getByText(/if an account exists for/i)).toBeInTheDocument());
  expect(screen.getByText('someone@example.com')).toBeInTheDocument();
  expect(global.fetch).toHaveBeenCalledWith('/api/auth/forgot-password', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ email: 'someone@example.com' }),
  }));
});
