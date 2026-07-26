import { render, screen } from '@testing-library/react';
import App from './App';

// Smoke test: the app shell mounts and renders navigation without crashing.
// The previous placeholder here (CRA's default "learn react" boilerplate)
// asserted text that has never existed in this app, so it always failed -
// nobody had run `npm test` since the project was scaffolded.
test('renders the navbar with a Home link when logged out', () => {
  render(<App />);
  // Both a desktop and mobile nav render at once (toggled by CSS media
  // query, not conditional rendering), so there's more than one "Home" link.
  expect(screen.getAllByRole('link', { name: /home/i }).length).toBeGreaterThan(0);
});
