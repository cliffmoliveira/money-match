import { render, screen, fireEvent } from '@testing-library/react';
import StakeStepper from './StakeStepper';

test('renders the current value and both step buttons', () => {
  render(<StakeStepper value="5" onChange={() => {}} />);
  expect(screen.getByLabelText('Stake')).toHaveValue(5);
  expect(screen.getByLabelText('Decrease stake')).toBeInTheDocument();
  expect(screen.getByLabelText('Increase stake')).toBeInTheDocument();
});

test('clicking + increases by step and clicking - decreases by step', () => {
  const onChange = jest.fn();
  render(<StakeStepper value="5" onChange={onChange} step={2} />);

  fireEvent.click(screen.getByLabelText('Increase stake'));
  expect(onChange).toHaveBeenLastCalledWith('7');

  fireEvent.click(screen.getByLabelText('Decrease stake'));
  expect(onChange).toHaveBeenLastCalledWith('3');
});

test('decrease is clamped at min and the button is disabled once value reaches it', () => {
  const onChange = jest.fn();
  render(<StakeStepper value="0" onChange={onChange} min={0} step={1} />);

  const decBtn = screen.getByLabelText('Decrease stake');
  expect(decBtn).toBeDisabled();

  fireEvent.click(decBtn);
  // Button is disabled, so the click shouldn't fire onChange at all.
  expect(onChange).not.toHaveBeenCalled();
});

test('typing directly into the input passes the raw string through onChange', () => {
  const onChange = jest.fn();
  render(<StakeStepper value="5" onChange={onChange} />);
  fireEvent.change(screen.getByLabelText('Stake'), { target: { value: '12.5' } });
  expect(onChange).toHaveBeenCalledWith('12.5');
});
