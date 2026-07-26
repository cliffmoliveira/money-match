import { render, screen, fireEvent } from '@testing-library/react';
import PasswordInput from './PasswordInput';

test('renders a masked password input by default', () => {
  render(<PasswordInput id="pw" name="password" value="" onChange={() => {}} />);
  const input = screen.getByPlaceholderText('••••••••');
  expect(input).toHaveAttribute('type', 'password');
  expect(screen.getByRole('button', { name: /show password/i })).toBeInTheDocument();
});

test('clicking the toggle reveals the password, then hides it again', () => {
  render(<PasswordInput id="pw" name="password" value="hunter2" onChange={() => {}} />);
  const input = screen.getByDisplayValue('hunter2');
  expect(input).toHaveAttribute('type', 'password');

  fireEvent.click(screen.getByRole('button', { name: /show password/i }));
  expect(input).toHaveAttribute('type', 'text');
  expect(screen.getByRole('button', { name: /hide password/i })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: /hide password/i }));
  expect(input).toHaveAttribute('type', 'password');
});

test('typing into the field calls onChange', () => {
  const onChange = jest.fn();
  render(<PasswordInput id="pw" name="password" value="" onChange={onChange} />);
  fireEvent.change(screen.getByPlaceholderText('••••••••'), { target: { value: 'abc' } });
  expect(onChange).toHaveBeenCalledTimes(1);
});
