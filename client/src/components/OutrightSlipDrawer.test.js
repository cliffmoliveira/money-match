import { render, screen, fireEvent } from '@testing-library/react';
import OutrightSlipDrawer from './OutrightSlipDrawer';

// OutrightSlipDrawer.js has no fetch calls of its own — driven entirely by
// props owned by useOutrightPicks.

const baseProps = {
  updateStake: jest.fn(),
  removeFromSlip: jest.fn(),
  totalStake: 25,
  placing: false,
  placeMsg: null,
  placeOutrights: jest.fn(),
};

const slipEntries = [
  ['outright_1', { playerName: 'EG | Player One', odds: 1.5, stake: '25' }],
];

afterEach(() => jest.clearAllMocks());

test('renders nothing when the slip is empty', () => {
  const { container } = render(
    <OutrightSlipDrawer {...baseProps} slipEntries={[]} slipOpen={false} setSlipOpen={() => {}} totalStake={0} />
  );
  expect(container).toBeEmptyDOMElement();
});

test('shows the floating tab when closed, and opening it reveals the slip contents', () => {
  const setSlipOpen = jest.fn();
  render(<OutrightSlipDrawer {...baseProps} slipEntries={slipEntries} slipOpen={false} setSlipOpen={setSlipOpen} />);

  const tab = screen.getByRole('button', { name: /open outright picks slip/i });
  expect(tab).toHaveTextContent('Picks (1)');

  fireEvent.click(tab);
  expect(setSlipOpen).toHaveBeenCalledWith(true);
});

test('when open, renders the staged pick and calls placeOutrights on submit', () => {
  const placeOutrights = jest.fn();
  render(
    <OutrightSlipDrawer
      {...baseProps}
      placeOutrights={placeOutrights}
      slipEntries={slipEntries}
      slipOpen={true}
      setSlipOpen={() => {}}
    />
  );

  expect(screen.getByText('EG | Player One')).toBeInTheDocument();
  expect(screen.getByText('@1.50')).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /place outrights/i }));
  expect(placeOutrights).toHaveBeenCalledTimes(1);
});

test('removing a staged pick calls removeFromSlip with its key', () => {
  const removeFromSlip = jest.fn();
  render(
    <OutrightSlipDrawer
      {...baseProps}
      removeFromSlip={removeFromSlip}
      slipEntries={slipEntries}
      slipOpen={true}
      setSlipOpen={() => {}}
    />
  );

  fireEvent.click(screen.getByRole('button', { name: /remove eg \| player one/i }));
  expect(removeFromSlip).toHaveBeenCalledWith('outright_1');
});
