import { useCallback, useEffect, useState } from 'react';

export const PAGES = [
  'practice',
  'calls',
  'deliveries',
  'settings',
  'users',
] as const;
export type Page = (typeof PAGES)[number];

export interface Route {
  page: Page;
  /** Selected item, e.g. the call attempt in #/calls/<id>. */
  id: string | null;
}

function parse(hash: string): Route {
  const [page, id] = hash.replace(/^#\/?/, '').split('/');
  return {
    page: (PAGES as readonly string[]).includes(page ?? '')
      ? (page as Page)
      : 'practice',
    id: id ? decodeURIComponent(id) : null,
  };
}

/** URL state lives in the hash so views can be linked and survive a reload. */
export function useRoute() {
  const [route, setRoute] = useState(() => parse(window.location.hash));
  useEffect(() => {
    const update = () => setRoute(parse(window.location.hash));
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);
  const navigate = useCallback((page: Page, id: string | null = null) => {
    window.location.hash = id
      ? `/${page}/${encodeURIComponent(id)}`
      : `/${page}`;
  }, []);
  return { route, navigate };
}
