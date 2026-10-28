import { expect, it } from 'vitest';
import { validReturnPath } from '../../src/worker/auth/google';

it('keeps OAuth return paths on the application origin', () => {
  const origin = 'https://campus.example.edu';
  expect(validReturnPath('/profile?tab=privacy#consent', origin)).toBe('/profile?tab=privacy#consent');
  for (const value of [
    '//attacker.example',
    'https://attacker.example/path',
    '/\\attacker.example',
    '/safe\nheader',
  ]) expect(validReturnPath(value, origin)).toBe('/');
});
