/**
 * Bundled timetable definitions.
 *
 * The JSON is inlined into the build, so the plans are available offline as soon
 * as the application shell is cached. Every definition is validated before it can
 * reach storage.
 */

import { assertUniqueVersions, parseTimetable } from '../domain/timetable';
import type { Timetable } from '../domain/types';

const modules = import.meta.glob<{ default: unknown }>('../timetables/*.json', { eager: true });

export const loadBundledTimetables = (): Timetable[] => {
  const timetables = Object.entries(modules)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, module]) => parseTimetable(module.default, path));

  assertUniqueVersions(timetables);
  return timetables;
};
