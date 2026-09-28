import { normalizePhoneNumber } from '../validators';

describe('normalizePhoneNumber', () => {
  it.each([
    ['+33612345678', '+33612345678'],
    ['+33 6 12 34 56 78', '+33612345678'],
    ['06 12 34 56 78', '+33612345678'],
    ['06.12.34.56.78', '+33612345678'],
    ['0033612345678', '+33612345678'],
    ['+1 (415) 555-2671', '+14155552671']
  ])('normalise %p en %p', (raw, expected) => {
    expect(normalizePhoneNumber(raw)).toBe(expected);
  });

  it.each([
    'abc123',
    '612345678', // ni indicatif ni 0 national : Twilio le refuserait
    '+0612345678',
    '+33',
    '',
    undefined,
    { $ne: null }
  ])('refuse %p', (raw) => {
    expect(normalizePhoneNumber(raw)).toBeNull();
  });
});
