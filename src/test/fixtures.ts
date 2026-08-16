import { parseTimetable } from '../domain/timetable';
import type { Timetable } from '../domain/types';

/** Three short items in a zone with no daylight saving, for arithmetic tests. */
export const simpleTimetable: Timetable = parseTimetable({
  id: 'test-plan',
  name: 'Test plan',
  version: 1,
  timezone: 'Asia/Kolkata',
  items: [
    { id: 'wake', label: 'Wake', plannedStart: '06:00', plannedEnd: '06:30' },
    { id: 'gym', label: 'Gym', plannedStart: '06:30', plannedEnd: '07:30' },
    { id: 'breakfast', label: 'Breakfast', plannedStart: '07:30', plannedEnd: '08:00' },
  ],
});

/** Same stable item IDs, different planned times — used for cross-version tests. */
export const simpleTimetableV2: Timetable = parseTimetable({
  id: 'test-plan',
  name: 'Test plan',
  version: 2,
  timezone: 'Asia/Kolkata',
  items: [
    { id: 'wake', label: 'Wake up', plannedStart: '06:00', plannedEnd: '06:20' },
    { id: 'gym', label: 'Gym', plannedStart: '06:20', plannedEnd: '07:30' },
    { id: 'breakfast', label: 'Breakfast', plannedStart: '07:30', plannedEnd: '08:10' },
  ],
});

/** Crosses local midnight, so day-offset resolution is exercised. */
export const overnightTimetable: Timetable = parseTimetable({
  id: 'overnight',
  name: 'Overnight',
  version: 1,
  timezone: 'Asia/Kolkata',
  items: [
    { id: 'wind-down', label: 'Wind down', plannedStart: '23:30', plannedEnd: '00:15' },
    { id: 'sleep-prep', label: 'Sleep prep', plannedStart: '00:15', plannedEnd: '00:45' },
  ],
});

export const minutes = (count: number): number => count * 60_000;

export const at = (iso: string): Date => new Date(iso);
