import { useEffect, useState } from 'react';

import type { Clock } from '../domain/clock';

/**
 * Elapsed milliseconds since `startedAt`, ticking once a second.
 *
 * Elapsed time is always derived from the recorded start instant using the same
 * clock that records transitions, so nothing is counted or stored and a refresh
 * cannot lose or drift it.
 */
export const useElapsed = (startedAt: Date | null, clock: Clock): number => {
  const [now, setNow] = useState(() => clock.now().getTime());

  useEffect(() => {
    if (!startedAt) return undefined;
    setNow(clock.now().getTime());
    const timer = window.setInterval(() => setNow(clock.now().getTime()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt, clock]);

  if (!startedAt) return 0;
  return Math.max(0, now - startedAt.getTime());
};
