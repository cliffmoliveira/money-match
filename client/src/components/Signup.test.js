import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Signup from './Signup';
import { renderWithRouter, mockFetchRoutes, setLoggedOut } from '../testUtils';

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('renders the signup form', () => {
  renderWithRouter(<Signup />);

  expect(screen.getByText(/create your account/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/display name/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  expect(screen.getByLabelText('Password')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument();
});

test('shows the server error message when the email is already in use', async () => {
  // mockFetchRoutes always resolves ok:true, so a non-2xx response needs to be
  // built by hand rather than via its response-table shape.
  global.fetch = jest.fn(() => Promise.resolve({
    ok: false,
    status: 409,
    json: async () => ({ error: 'Email already in use.' }),
  }));

  renderWithRouter(<Signup />);
  const user = userEvent.setup();

  await user.type(screen.getByLabelText(/display name/i), 'FGCFan');
  await user.type(screen.getByLabelText(/email/i), 'taken@example.com');
  await user.type(screen.getByLabelText('Password'), 'correcthorse');
  await user.click(screen.getByRole('button', { name: /create account/i }));

  await waitFor(() => expect(screen.getByText(/email already in use/i)).toBeInTheDocument());
  expect(screen.queryByText(/account created successfully/i)).not.toBeInTheDocument();
});

test('signs up successfully and shows the redirect-to-login message', async () => {
  mockFetchRoutes([
    ['/api/auth/signup', { message: 'Account created successfully', userId: 77 }],
  ]);

  renderWithRouter(<Signup />);
  const user = userEvent.setup();

  await user.type(screen.getByLabelText(/display name/i), 'FGCFan');
  await user.type(screen.getByLabelText(/email/i), 'new@example.com');
  await user.type(screen.getByLabelText('Password'), 'correcthorse');
  await user.click(screen.getByRole('button', { name: /create account/i }));

  await waitFor(() => expect(screen.getByText(/account created successfully/i)).toBeInTheDocument());
  expect(global.fetch).toHaveBeenCalledWith('/api/auth/signup', expect.objectContaining({
    method: 'POST',
    body: JSON.stringify({ username: 'FGCFan', email: 'new@example.com', password: 'correcthorse' }),
  }));
});

test('toggles password visibility', async () => {
  renderWithRouter(<Signup />);
  const user = userEvent.setup();

  const passwordInput = screen.getByLabelText('Password');
  expect(passwordInput).toHaveAttribute('type', 'password');

  await user.click(screen.getByRole('button', { name: /show password/i }));
  expect(passwordInput).toHaveAttribute('type', 'text');
});
