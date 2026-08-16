/**
 * Service worker registration.
 *
 * Registration is deliberately fire-and-forget and never blocks start-up: if it
 * fails, Quartz still works, it simply is not yet available offline.
 */
export const registerServiceWorker = (): void => {
  if (import.meta.env.DEV) return;
  if (!('serviceWorker' in navigator)) return;

  const base = import.meta.env.BASE_URL;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(`${base}sw.js`, { scope: base }).catch(() => {
      /* Offline support is an enhancement, not a requirement to run. */
    });
  });
};
