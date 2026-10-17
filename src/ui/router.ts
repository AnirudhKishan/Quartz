import { useEffect, useState } from 'react';

export type Route =
  | { kind: 'select' }
  | { kind: 'run' }
  | { kind: 'reports' }
  | { kind: 'run-report'; runId: string }
  | { kind: 'timetable-report'; timetableId: string; version: number | null }
  | { kind: 'settings' }
  | { kind: 'data' };

/**
 * Hash routing.
 *
 * A static host such as GitHub Pages has no rewrite rules, so hash routes keep
 * refresh and deep links working from any base path.
 */
export const parseRoute = (hash: string): Route => {
  const withoutHash = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = withoutHash.split('?');
  const [head, ...rest] = path.split('/');

  switch (head) {
    case 'run':
      return { kind: 'run' };
    case 'reports': {
      if (rest[0] === 'run' && rest[1]) return { kind: 'run-report', runId: decodeURIComponent(rest[1]) };
      if (rest[0] === 'timetable' && rest[1]) {
        const rawVersion = new URLSearchParams(query).get('version');
        const parsedVersion = rawVersion === null ? null : Number(rawVersion);
        return {
          kind: 'timetable-report',
          timetableId: decodeURIComponent(rest[1]),
          version:
            parsedVersion !== null && Number.isInteger(parsedVersion) && parsedVersion > 0
              ? parsedVersion
              : null,
        };
      }
      return { kind: 'reports' };
    }
    case 'data':
      return { kind: 'data' };
    case 'settings':
      return { kind: 'settings' };
    default:
      return { kind: 'select' };
  }
};

export const routeToHash = (route: Route): string => {
  switch (route.kind) {
    case 'run':
      return '#/run';
    case 'reports':
      return '#/reports';
    case 'run-report':
      return `#/reports/run/${encodeURIComponent(route.runId)}`;
    case 'timetable-report':
      return `#/reports/timetable/${encodeURIComponent(route.timetableId)}${
        route.version === null ? '' : `?version=${route.version}`
      }`;
    case 'data':
      return '#/data';
    case 'settings':
      return '#/settings';
    default:
      return '#/';
  }
};

export const navigate = (route: Route): void => {
  window.location.hash = routeToHash(route);
};

export const useRoute = (): Route => {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
};
