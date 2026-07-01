import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Navbar from './components/Navbar';
import Home from './components/Home';
import LiveBetting from './components/LiveBetting';
import Login from './components/Login';
import Signup from './components/Signup';
import AffiliateDemo from './components/AffiliateDemo';
import ForgotPassword from './components/ForgotPassword';
import ResetPassword from './components/ResetPassword';
import Leaderboard from './components/Leaderboard';
import Profile from './components/Profile';
import AccountSettings from './components/AccountSettings';
import Exhibitions from './components/Exhibitions';
import Follow from './components/Follow';

// Inner shell so we can read the current route (useLocation must be inside
// <Router>) and hide the navbar on the auth screens, per the redesign.
function AppShell({ isLoggedIn, setIsLoggedIn }) {
  const { pathname } = useLocation();
  const hideNav = ['/login', '/signup', '/forgot-password', '/reset-password'].includes(pathname);

  return (
    <>
      {!hideNav && <Navbar isLoggedIn={isLoggedIn} setIsLoggedIn={setIsLoggedIn} />}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={isLoggedIn ? <Navigate to="/" /> : <Login setIsLoggedIn={setIsLoggedIn} />} />
        <Route path="/signup" element={<Signup />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
        <Route
          path="/tournaments"
          element={isLoggedIn ? <LiveBetting /> : <Navigate to="/login" />}
        />
        {/* Back-compat redirects — old routes now point at the unified page */}
        <Route path="/brackets" element={<Navigate to="/tournaments" replace />} />
        <Route path="/future-tournaments" element={<Navigate to="/tournaments" replace />} />
        <Route path="/past-results" element={<Navigate to="/tournaments" replace />} />
        <Route path="/leaderboard" element={<Leaderboard />} />
        <Route path="/profile" element={isLoggedIn ? <Profile /> : <Navigate to="/login" />} />
        <Route path="/follow" element={isLoggedIn ? <Follow /> : <Navigate to="/login" />} />
        <Route path="/account" element={isLoggedIn ? <AccountSettings /> : <Navigate to="/login" />} />
        <Route path="/exhibitions" element={<Exhibitions />} />
        <Route path="/affiliate-demo" element={<AffiliateDemo />} />
      </Routes>
    </>
  );
}

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(!!localStorage.getItem('authToken'));

  return (
    <Router>
      <AppShell isLoggedIn={isLoggedIn} setIsLoggedIn={setIsLoggedIn} />
    </Router>
  );
}

export default App;
