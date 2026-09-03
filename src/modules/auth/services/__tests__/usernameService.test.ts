import { slugifyUsername, splitDisplayName } from '../usernameService';

describe('slugifyUsername', () => {
  it('reduces a display name to lowercase ascii with dashes', () => {
    expect(slugifyUsername('Marie Dupont')).toBe('marie-dupont');
  });

  it('strips diacritics rather than dropping the characters', () => {
    expect(slugifyUsername('Chloé Ébène')).toBe('chloe-ebene');
  });

  it('collapses runs of punctuation into a single separator', () => {
    expect(slugifyUsername("Jean-Luc  O'Brien")).toBe('jean-luc-o-brien');
  });

  it('never returns leading or trailing separators', () => {
    expect(slugifyUsername('  ...Marie...  ')).toBe('marie');
  });

  it('returns an empty string when no ascii character is usable', () => {
    expect(slugifyUsername('김민준')).toBe('');
  });

  it('returns an empty string for missing input', () => {
    expect(slugifyUsername(undefined)).toBe('');
    expect(slugifyUsername(null)).toBe('');
    expect(slugifyUsername('')).toBe('');
  });

  it('truncates to 30 characters without leaving a trailing separator', () => {
    const slug = slugifyUsername('Marie Antoinette Josephe Jeanne de Habsbourg');
    expect(slug.length).toBeLessThanOrEqual(30);
    expect(slug).not.toMatch(/[-_]$/);
  });
});

describe('splitDisplayName', () => {
  it('splits a two-part name into first and last name', () => {
    expect(splitDisplayName('Marie Dupont')).toEqual({
      firstName: 'Marie',
      lastName: 'Dupont'
    });
  });

  it('keeps compound family names together', () => {
    expect(splitDisplayName('Marie de La Fontaine')).toEqual({
      firstName: 'Marie',
      lastName: 'de La Fontaine'
    });
  });

  it('returns only a first name when there is a single part', () => {
    expect(splitDisplayName('Marie')).toEqual({ firstName: 'Marie' });
  });

  it('returns an empty object for missing input', () => {
    expect(splitDisplayName(undefined)).toEqual({});
    expect(splitDisplayName('   ')).toEqual({});
  });
});
