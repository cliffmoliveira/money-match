import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Navbar from './components/Navbar';
import Home from './components/Home';
import FutureTournaments from './components/FutureTournaments';
import LiveBetting from './components/LiveBetting';
import PastResults from './components/PastResults';
import Login from './components/Login';
import Signup from './components/Signup';

function App() {
  const [isLoggedIn, setIsLoggedIn] = useState(!!localStorage.getItem('authToken'));

  return (
    <Router>
      <Navbar isLoggedIn={isLoggedIn} setIsLoggedIn={setIsLoggedIn} />
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
      </Routes>
    </Router>
  );
}

export default App;
