export const libraryPageThreshold = 200;
export const libraryPageSize = 100;

export function libraryPage<T>(tracks: T[], requestedPage: number) {
  const pages = tracks.length > libraryPageThreshold ? Math.ceil(tracks.length / libraryPageSize) : 1;
  const page = Math.max(0, Math.min(pages - 1, Math.floor(requestedPage) || 0));
  const offset = pages > 1 ? page * libraryPageSize : 0;
  return { page, pages, offset, tracks: pages > 1 ? tracks.slice(offset, offset + libraryPageSize) : tracks };
}
