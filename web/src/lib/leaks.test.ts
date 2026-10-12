import { expect, it } from 'vitest';
import { leaks } from './leaks';

it('finds a word as itself, not by chance inside random ciphertext', () => {
  expect(leaks('{"title":"Sam"}', 'Sam')).toBe(true);
  expect(leaks('{"content":"q9xSamZ+/w=="}', 'Sam')).toBe(false);
  expect(leaks('room 1203, Bloor St', '1203')).toBe(true);
  expect(leaks('"created_at":17912031', '1203')).toBe(false);
});
