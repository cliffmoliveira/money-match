import React, { useState, useEffect } from 'react';
import axios from 'axios';
import './Startgg.css';

const API_URL = 'https://api.start.gg/gql/alpha';
const STARTGG_TOKEN = 'c69e996435016150623130ab805d440e'; // Hardcoded token

const StartggPast = () => {
  const [winner, setWinner] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchStreetFighter6Winner = async () => {
      setLoading(true);
      try {
        const eventSlug = "evo-2024/event/street-fighter-6"; // Slug for Street Fighter 6 at Evo 2024
        const setsQuery = `
          query getEventSets($eventSlug: String!) {
            event(slug: $eventSlug) {
              name
              sets(
                page: 1
                perPage: 10
                sortType: STANDARD
              ) {
                nodes {
                  id
                  round
                  winnerId
                  slots {
                    entrant {
                      id
                      name
                    }
                  }
                }
              }
            }
          }
        `;

        const setsResponse = await axios.post(
          API_URL,
          {
            query: setsQuery,
            variables: { eventSlug },
          },
          {
            headers: {
              Authorization: `Bearer ${STARTGG_TOKEN}`,
              'Content-Type': 'application/json',
            },
          }
        );

        console.log('All Sets Response:', setsResponse.data); // Debug the response

        const sets = setsResponse.data?.data?.event?.sets?.nodes || [];
        if (sets.length === 0) {
          throw new Error('No sets found for the event.');
        }

        // Attempt to identify the Grand Final set
        const grandFinalSet = sets.find((set) =>
          set.round.toLowerCase().includes('grand final')
        );

        if (!grandFinalSet) {
          throw new Error('Grand Final set not found.');
        }

        const winnerName = grandFinalSet.slots.find((slot) => slot?.entrant)?.entrant?.name || 'TBD';
        setWinner(winnerName);
      } catch (err) {
        console.error('Error fetching Street Fighter 6 winner:', err.response?.data || err.message); // Log error details
        setError('Failed to fetch Street Fighter 6 winner.');
      } finally {
        setLoading(false);
      }
    };

    fetchStreetFighter6Winner();
  }, []);

  return (
    <div className="startgg-past-container">
      <h1>Street Fighter 6 Winner at Evo 2024</h1>

      {loading && <p>Loading...</p>}
      {error && <p className="error">{error}</p>}

      {!loading && !error && (
        <table className="tournament-table">
          <thead>
            <tr>
              <th>Event</th>
              <th>Winner</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Street Fighter 6</td>
              <td>{winner || 'TBD'}</td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
};

export default StartggPast;
