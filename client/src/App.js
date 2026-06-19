import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Navbar from './components/Navbar';
import Home from './components/Home';
import FutureTournaments from './components/FutureTournaments';
import LiveBetting from './components/LiveBetting';
import PastResults from './components/PastResults';
import Login from './components/Login';
import Signup from './components/Signup';
import AffiliateDemo from './components/AffiliateDemo';
import Leaderboard from './components/Leaderboard';

// Inner shell so we can read the current route (useLocation must be inside
// <Router>) and hide the navbar on the auth screens, per the redesign.
function AppShell({ isLoggedIn, setIsLoggedIn }) {
  const { pathname } = useLocation();
  const hideNav = pathname === '/login' || pathname === '/signup';

  return (
    <>
      {!hideNav && <Navbar isLoggedIn={isLoggedIn} setIsLoggedIn={setIsLoggedIn} />}
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={isLoggedIn ? <Navigate to="/" /> : <Login setIsLoggedIn={setIsLoggedIn} />} />
        <Route path="/signup" element={<Signup />} />
        <Route
          path="/past-results"
          element={isLoggedIn ? <PastResults /> : <Navigate to="/login" />}
        />
        <Route
          path="/future-tournaments"
          element={isLoggedIn ? <FutureTournaments /> : <Navigate to="/login" />}
        />
        <Route
          path="/live"
          element={isLoggedIn ? <LiveBetting /> : <Navigate to="/login" />}
        />
        <Route path="/leaderboard" element={<Leaderboard />} />
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
