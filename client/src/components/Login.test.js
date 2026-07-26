import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Login from './Login';
import { renderWithRouter, mockFetchRoutes, setLoggedOut } from '../testUtils';

// "Log in" also labels the auth-toggle button up top (type=button), so
// name: /log in/i alone is ambiguous - this always grabs the actual submit button.
const submitButton = () => screen.getAllByRole('button', { name: /log in/i }).find((b) => b.type === 'submit');

afterEach(() => {
  jest.restoreAllMocks();
  setLoggedOut();
});

test('renders the login form', () => {
  renderWithRouter(<Login setIsLoggedIn={jest.fn()} />);

  expect(screen.getByText(/welcome back/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/email/i)).toBeInTheDocument();
  expect(screen.getByLabelText('Password')).toBeInTheDocument();
  expect(submitButton()).toBeInTheDocument();
});

test('shows the "session expired" banner when the URL has ?expired=1', () => {
  renderWithRouter(<Login setIsLoggedIn={jest.fn()} />, { route: '/login?expired=1' });

  expect(screen.getByText(/your session expired/i)).toBeInTheDocument();
});

test('does not show the session-expired banner on a normal visit', () => {
  renderWithRouter(<Login setIsLoggedIn={jest.fn()} />, { route: '/login' });

  expect(screen.queryByText(/your session expired/i)).not.toBeInTheDocument();
});

test('shows the server error message on invalid credentials', async () => {
  // mockFetchRoutes always resolves ok:true, so a non-2xx response needs to be
  // built by hand rather than via its response-table shape.
  global.fetch = jest.fn(() => Promise.resolve({
    ok: false,
    status: 401,
    json: async () => ({ error: 'Invalid email or password.' }),
  }));

  const setIsLoggedIn = jest.fn();
  renderWithRouter(<Login setIsLoggedIn={setIsLoggedIn} />);

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/email/i), 'wrong@example.com');
  await user.type(screen.getByLabelText('Password'), 'wrongpassword');
  await user.click(submitButton());

  await waitFor(() => expect(screen.getByText(/invalid email or password/i)).toBeInTheDocument());
  expect(setIsLoggedIn).not.toHaveBeenCalled();
  expect(localStorage.getItem('authToken')).toBeNull();
});

test('logs in successfully, stores the session, and navigates home', async () => {
  mockFetchRoutes([
    ['/api/auth/login', { token: 'abc123', userId: 42, username: 'FGCFan' }],
  ]);

  const setIsLoggedIn = jest.fn();
  renderWithRouter(<Login setIsLoggedIn={setIsLoggedIn} />, { route: '/login' });

  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/email/i), 'fan@example.com');
  await user.type(screen.getByLabelText('Password'), 'correcthorse');
  await user.click(submitButton());

  await waitFor(() => expect(setIsLoggedIn).toHaveBeenCalledWith(true));
  expect(localStorage.getItem('authToken')).toBe('abc123');
  expect(localStorage.getItem('userId')).toBe('42');
  expect(localStorage.getItem('username')).toBe('FGCFan');
});

test('toggles password visibility', async () => {
  renderWithRouter(<Login setIsLoggedIn={jest.fn()} />);
  const user = userEvent.setup();

  const passwordInput = screen.getByLabelText('Password');
  expect(passwordInput).toHaveAttribute('type', 'password');

  await user.click(screen.getByRole('button', { name: /show password/i }));
  expect(passwordInput).toHaveAttribute('type', 'text');
});
