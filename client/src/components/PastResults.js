import React, { useEffect, useState } from 'react';
import './PastResults.css';

const PastResults = () => {
  const [pastResults, setPastResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchPastResults = async () => {
      try {
        const response = await fetch('/api/past-results');
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        // Sort the data by descending date
        const sortedData = data.data.sort((a, b) => new Date(b.date) - new Date(a.date));

        setPastResults(sortedData);
      } catch (err) {
        console.error('Error fetching past results:', err);
        setError('Failed to load past results. Please try again later.');
      } finally {
        setLoading(false);
      }
    };

    fetchPastResults();
  }, []);

  if (loading) {
    return <p>Loading past results...</p>;
  }

  if (error) {
    return <p className="error-message">{error}</p>;
  }

  return (
    <div className="past-results-container">
      <h1>Past Results</h1>
      {pastResults.length === 0 ? (
        <p>No past results available.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tournament</th>
              <th>Location</th>
              <th>Date</th>
              <th>Game</th>
              <th>Winner</th>
              <th>Rounds</th>
              <th>Loser</th>
            </tr>
          </thead>
          <tbody>
            {pastResults.map((result) => (
              <tr key={result.id}>
                <td>{result.tournament}</td>
                <td>{`${result.city || 'Unknown'}, ${result.country || 'Unknown'}`}</td>
                <td>{new Date(result.date).toLocaleDateString()}</td>
                <td>{result.game}</td>
                <td>{result.winner}</td>
                <td>{`${result.winnerRoundsWon} : ${result.loserRoundsWon}`}</td>
                <td>{result.loser}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
};

export default PastResults;
