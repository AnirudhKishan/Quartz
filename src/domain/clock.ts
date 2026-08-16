/** Injected time and identity, so every command is deterministic under test. */

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  newRunId(localDatePrefix: string): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export const fixedClock = (instants: readonly Date[]): Clock => {
  let index = 0;
  return {
    now: () => {
      const instant = instants[Math.min(index, instants.length - 1)];
      index += 1;
      if (!instant) throw new Error('fixedClock was created with no instants');
      return new Date(instant.getTime());
    },
  };
};

const randomSuffix = (): string => {
  const bytes = new Uint8Array(6);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

/** Run IDs sort chronologically, which keeps event IDs sortable too. */
export const systemIdGenerator: IdGenerator = {
  newRunId: (localDatePrefix: string) =>
    `run-${localDatePrefix}-${Date.now().toString(36)}-${randomSuffix()}`,
};

export const sequentialIdGenerator = (prefix = 'run'): IdGenerator => {
  let counter = 0;
  return {
    newRunId: (localDatePrefix: string) => {
      counter += 1;
      return `${prefix}-${localDatePrefix}-${String(counter).padStart(4, '0')}`;
    },
  };
};
