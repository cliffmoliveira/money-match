// Shared helpers for component tests (client/src/**/*.test.js). Keeping the
// fetch-mocking and router-wrapping conventions in one place means every
// test file mocks the network the same way, so a real endpoint's response
// shape only needs to be modeled correctly once per test, not reinvented
// per file.
import React from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Renders `ui` inside a MemoryRouter, since almost every component here uses
// react-router-dom hooks (useNavigate, useLocation, Link) and throws without
// a Router ancestor.
export function renderWithRouter(ui, { route = '/', ...options } = {}) {
  window.history.pushState({}, '', route);
  return render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>, options);
}

// Tag a route's response as a non-2xx result: mockFetchRoutes(['/api/x',
// errorResponse(403, { error: 'Forbidden' })]) - without this, every mocked
// response is ok:200, which can't exercise a component's error-handling
// paths (401s, validation errors, etc.) through the shared helper.
const ERROR_TAG = Symbol('mockFetchRoutes.error');
export function errorResponse(status, body = {}) {
  return { [ERROR_TAG]: true, status, body };
}

// Mocks global fetch (which apiFetch() in utils/api.js also calls through
// to) against a table of [urlPattern, response] pairs. `urlPattern` is
// matched by substring if a string, or `.test(url)` if a RegExp - so a route
// like '/api/live/markets' won't accidentally also match
// '/api/live/markets/foo' unless you want it to (use a RegExp for exact
// matches). Substring matching also means one endpoint's path can be a
// substring of another's ('/api/admin/exhibition' vs '/api/admin/exhibitions')
// - use an anchored RegExp (/\/api\/admin\/exhibitions$/) when that's a risk.
// `response` is either a plain value (serves it as ok:200 JSON), the result
// of errorResponse() (serves it as ok:false with that status), or a function
// `(url, options) => value` for responses that depend on the request (can
// itself return an errorResponse()). Any URL not in the table resolves to a
// 404 rather than hanging - an unmocked call fails the assertion it feeds
// instead of silently stalling the test, which is what should happen: a
// component now depends on an endpoint the test didn't know to expect.
export function mockFetchRoutes(routes) {
  const calls = [];
  global.fetch = jest.fn((url, opts) => {
    calls.push(url);
    // Last match wins (searched in reverse) - so `[...BASE_ROUTES, ['/x', override]]`
    // behaves like object spread `{...BASE, x: override}` instead of the
    // opposite, which is the natural way to write "start from a base set of
    // routes, then override just the one this test cares about".
    const entry = [...routes].reverse().find(([pattern]) =>
      typeof pattern === 'string' ? url.includes(pattern) : pattern.test(url)
    );
    if (!entry) {
      return Promise.resolve({
        ok: false, status: 404,
        json: async () => ({ error: `mockFetchRoutes: no route configured for ${url}` }),
      });
    }
    const [, data] = entry;
    const resolved = typeof data === 'function' ? data(url, opts) : data;
    if (resolved && resolved[ERROR_TAG]) {
      return Promise.resolve({ ok: false, status: resolved.status, json: async () => resolved.body });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => resolved });
  });
  global.fetch.mock.calledUrls = calls; // convenience: inspect what a component actually requested
  return global.fetch;
}

// Puts the app in "logged in" state the same way a real login does -
// apiFetch() (utils/api.js) reads these three keys directly from localStorage.
export function setLoggedIn({ userId = 9014, username = 'DevTester', token = 'test-token' } = {}) {
  window.localStorage.setItem('authToken', token);
  window.localStorage.setItem('userId', String(userId));
  window.localStorage.setItem('username', username);
}

export function setLoggedOut() {
  window.localStorage.removeItem('authToken');
  window.localStorage.removeItem('userId');
  window.localStorage.removeItem('username');
}
