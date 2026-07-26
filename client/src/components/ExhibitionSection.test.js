import { render, screen } from '@testing-library/react';
import ExhibitionSection from './ExhibitionSection';

// ex.state governs both which sub-layout an exhibition lands in (active vs.
// settled) and, for a live one, which badge it gets.
const liveEx = {
  id: 1, state: 'open', player1_name: 'Punk', player2_name: 'MenaRD',
  game_name: 'Street Fighter 6', tournament_name: 'Evo 2026', notes: null,
};
const settledEx = {
  id: 2, state: 'settled', player1_name: 'Punk', player2_name: 'MenaRD',
  winner_name: 'MenaRD', winner_score: 3, loser_score: 1,
  game_name: 'Street Fighter 6', tournament_name: 'Evo 2026',
  tournament_logo_url: null, event_date: '2026-07-20T18:00:00Z',
  city: null, country: null,
};

test('renders nothing when there are no exhibitions', () => {
  const { container } = render(<ExhibitionSection exhibitions={[]} title="Exhibitions" />);
  expect(container).toBeEmptyDOMElement();
});

test('renders a live (open) exhibition as a card with a LIVE badge and both player names', () => {
  render(<ExhibitionSection exhibitions={[liveEx]} title="Live Exhibitions" />);

  expect(screen.getByText('Live Exhibitions')).toBeInTheDocument();
  expect(screen.getByText('Punk')).toBeInTheDocument();
  expect(screen.getByText('MenaRD')).toBeInTheDocument();
  expect(screen.getByText('LIVE')).toBeInTheDocument();
});

test('renders a settled exhibition in cards layout with the winner marked, not the loser', () => {
  render(<ExhibitionSection exhibitions={[settledEx]} title="Exhibition Results" layout="cards" />);

  expect(screen.getByText('MenaRD')).toBeInTheDocument();
  expect(screen.getByText('Punk')).toBeInTheDocument();
  expect(screen.getByText('def.')).toBeInTheDocument();
});

test('renders a settled exhibition in table layout with winner/score/loser columns', () => {
  render(<ExhibitionSection exhibitions={[settledEx]} title="Exhibition Results" layout="table" />);

  // Table + mobile-card variants both render, so winner/loser names appear twice.
  expect(screen.getAllByText('MenaRD').length).toBeGreaterThan(0);
  expect(screen.getByText('3 – 1')).toBeInTheDocument();
});
