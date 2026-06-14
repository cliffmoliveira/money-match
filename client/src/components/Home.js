import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import './Home.css';
import { getTournamentLogoSources, getTournamentAlt, getTournamentLogoStyle } from '../utils/tournamentLogos';
import { getGameLogoSources, getGameAlt, getGameLogoStyle } from '../utils/gameLogos';


const Home = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [upcoming, setUpcoming] = useState([]);
  const [allTournaments, setAllTournaments] = useState([]);
  const [recentChampions, setRecentChampions] = useState([]);
  const [games, setGames] = useState([]);
  const [players, setPlayers] = useState([]);

  const [bets, setBets] = useState([]);
  const [betsLoading, setBetsLoading] = useState(false);

  const userId = localStorage.getItem('userId');

  useEffect(() => {
    const fetchData = async () => {
      try {
        const [tournamentsRes, allTournamentsRes, pastRes, gamesRes, playersRes] = await Promise.all([
          fetch('/api/tournaments'),
          fetch('/api/tournaments/all'),
          fetch('/api/past-results'),
          fetch('/api/games'),
          fetch('/api/players')
        ]);

        if (!tournamentsRes.ok || !allTournamentsRes.ok || !pastRes.ok || !gamesRes.ok || !playersRes.ok) {
          throw new Error('Failed to load homepage data');
        }

        const tournaments = await tournamentsRes.json();
        const allTournamentsData = await allTournamentsRes.json();
        const past = await pastRes.json();
        const gamesData = await gamesRes.json();
        const playersData = await playersRes.json();

        setGames(gamesData);
        setPlayers(playersData);
        setAllTournaments(allTournamentsData);

        const sortedUpcoming = (tournaments || []).slice().sort(
          (a, b) => new Date(a.date) - new Date(b.date)
        );
        setUpcoming(sortedUpcoming);

        const champions = (past?.data || [])
          .slice()
          .sort((a, b) => new Date(b.date) - new Date(a.date))
          .slice(0, 6)
          .map(r => ({
            tournament: r.tournament,
            date: r.date,
            game: r.game,
            winner: r.winner,
            loser: r.loser,
            score: `${r.winnerRoundsWon}-${r.loserRoundsWon}`
          }));
        setRecentChampions(champions);
      } catch (err) {
        console.error('Home load error:', err.message);
        setError('Failed to load homepage. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  useEffect(() => {
    const fetchBets = async () => {
      if (!userId) return;
      setBetsLoading(true);
      try {
        const response = await fetch(`/api/bets?userId=${userId}`);
        if (!response.ok) throw new Error('Failed to fetch bets');
        const betsData = await response.json();
        setBets(betsData);
      } catch (err) {
        console.error('Bets load error:', err.message);
      } finally {
        setBetsLoading(false);
      }
    };

    fetchBets();
  }, [userId]);

  const TournamentLogo = ({ name, height = 24 }) => {
    const [index, setIndex] = useState(0);
    if (!name) return null;

    const { avif, webp, png, jpg, jpeg } = getTournamentLogoSources(name);
    const candidates = [avif, webp, png, jpg, jpeg].filter(Boolean);
    const src = candidates[index];

    if (!src) {
      return <span>{name}</span>;
    }

    return (
      <img
        src={src}
        alt={getTournamentAlt(name)}
        style={getTournamentLogoStyle(name, height)}
        title={src}
        onError={() => {
          if (index + 1 < candidates.length) {
            setIndex(index + 1);
          }
        }}
      />
    );
  };

  const GameLogo = ({ name, height = 24, customStyles = {} }) => {
    const [index, setIndex] = useState(0);
    if (!name) return null;

    const { avif, webp, png, jpg, jpeg } = getGameLogoSources(name);
    const candidates = [avif, webp, png, jpg, jpeg].filter(Boolean);
    const src = candidates[index];

    if (!src) {
      return <span>{name}</span>;
    }

    return (
      <img
        src={src}
        alt={getGameAlt(name)}
        style={getGameLogoStyle(name, height, customStyles)}
        onError={() => {
          if (index + 1 < candidates.length) {
            setIndex(index + 1);
          }
        }}
      />
    );
  };

  const getGameName = (id) => games.find(g => g.id === id)?.name || id;
  const getPlayerName = (id) => players.find(p => p.id === id)?.name || id;
  const getTournamentName = (id) => allTournaments.find(t => t.id === id)?.name || id;

  if (loading) {
    return <div className="home-container"><div className="skeleton">Loading…</div></div>;
  }

  if (error) {
    return <div className="home-container"><div className="error-message">{error}</div></div>;
  }

  const spotlight = upcoming?.slice(0, 4);
  
  return (
    <div className="home-container">
      {/* Upcoming Spotlight */}
      {spotlight && spotlight.length > 0 && (
        <section className="spotlight">
          <div className="section-header">
            <h2>Next Up</h2>
            <Link to="/future-tournaments" className="link">See all</Link>
          </div>
          <div className="spotlight-grid">
            {spotlight.map(t => (
              <div key={t.id} className="spotlight-card">
                <div className="spotlight-header">
                  <h3>
                    <TournamentLogo name={t.name} height={24} />
                    <span style={{ marginLeft: '10px' }}>{t.name}</span>
                  </h3>
                </div>
                <div className="spotlight-date">{new Date(t.date).toLocaleDateString()}</div>
                <div className="spotlight-location">
                  {t.location?.city}, {t.location?.country}
                </div>
                <div className="spotlight-games">
                  {(Object.values(t.games || {}) || []).slice(0, 4).map(g => (
                    <span key={g.id} className="pill">{g.name}</span>
                  ))}
                  {Object.values(t.games || {}).length > 4 && (
                    <span className="more-pill">+{Object.values(t.games || {}).length - 4} more</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Recent Champions */}
      <section className="champions">
        <div className="section-header">
          <h2>Recent Champions</h2>
          <Link to="/past-results" className="link">See all</Link>
        </div>
        <div className="champion-grid">
          {recentChampions.map((c, i) => (
            <div key={i} className="champion-card">
              <div className="champion-game">
                <GameLogo name={c.game} height={32} />
              </div>
              <div className="champion-winner">{c.winner}</div>
              <div className="champion-meta">
                <span className="champion-tournament">{c.tournament}</span>
                <span className="champion-date">{new Date(c.date).toLocaleDateString()}</span>
              </div>
              <div className="champion-score">{c.score} vs {c.loser}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Your Bets (if logged in) */}
      {userId && (
        <section className="bets">
          <div className="section-header">
            <h2>Your Bets</h2>
            <Link to="/future-tournaments" className="link">Place bets</Link>
          </div>
          {betsLoading ? (
            <div className="skeleton">Loading bets…</div>
          ) : bets.length === 0 ? (
            <p className="muted">No bets yet.</p>
          ) : (
            <div className="bets-grid">
              {bets.slice(0, 6).map((b, i) => (
                <div key={i} className="bet-card">
                  <div className="bet-tournament">
                    <TournamentLogo name={getTournamentName(b.tournament_id)} height={20} />
                    <span className="bet-tournament-name">{getTournamentName(b.tournament_id)}</span>
                  </div>
                  <div className="bet-game">
                    <GameLogo name={getGameName(b.game_id)} height={24} />
                  </div>
                  <div className="bet-player">{getPlayerName(b.player_id)}</div>
                  <div className="bet-amount">${Number(b.amount || 0).toFixed(2)}</div>
                  <div className={`bet-outcome ${b.is_winner === 1 ? 'win' : b.is_winner === 0 ? 'loss' : 'pending'}`}>
                    {b.is_winner === 1 ? 'Win' : b.is_winner === 0 ? 'Loss' : 'Pending'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
};

export default Home;
