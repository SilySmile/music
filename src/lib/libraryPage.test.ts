import { describe, expect, it } from 'vitest';
import { libraryPage } from './libraryPage';

describe('incremental music list rendering', () => {
  it('keeps small libraries on a single page without copying the list', () => {
    const tracks = Array.from({ length: 200 }, (_, index) => index);
    expect(libraryPage(tracks, 8)).toEqual({ page: 0, pages: 1, offset: 0, tracks });
    expect(libraryPage(tracks, 0).tracks).toBe(tracks);
    expect(libraryPage([], 0).pages).toBe(1);
  });
  it('appends chunks without dropping earlier songs and clamps after filtering', () => {
    const tracks = Array.from({ length: 10001 }, (_, index) => index);
    const first = libraryPage(tracks, 0);
    expect(first.tracks).toHaveLength(100);
    expect(first.pages).toBe(101);
    expect(libraryPage(tracks, 1).tracks).toEqual(tracks.slice(0, 200));
    expect(libraryPage(tracks, 1000).tracks).toHaveLength(10001);
    expect(libraryPage(tracks, 1000).offset).toBe(0);
    expect(libraryPage(tracks, -1).page).toBe(0);
    expect(libraryPage(tracks.slice(0, 304), 100).page).toBe(3);
    expect(tracks).toHaveLength(10001);
  });
});
