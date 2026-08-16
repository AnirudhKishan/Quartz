import { useCallback, useEffect, useState } from 'react';

export type AsyncResult<T> =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'failed'; readonly error: Error };

/** Load read-only data for a screen. Reports never mutate anything. */
export const useAsync = <T,>(load: () => Promise<T>, deps: readonly unknown[]): AsyncResult<T> => {
  const [result, setResult] = useState<AsyncResult<T>>({ status: 'loading' });

  // The loader closes over the caller's dependencies, which are the real inputs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(load, deps);

  useEffect(() => {
    let cancelled = false;
    setResult({ status: 'loading' });
    run()
      .then((value) => {
        if (!cancelled) setResult({ status: 'ready', value });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResult({
            status: 'failed',
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [run]);

  return result;
};
