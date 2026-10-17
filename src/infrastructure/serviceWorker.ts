/**
 * Service worker registration and explicit update control.
 *
 * Quartz never reloads automatically. A new worker waits until the user chooses
 * Apply update, which keeps an active tracked day stable.
 */

export type AppUpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'update-ready'
  | 'error';

type Listener = (status: AppUpdateStatus) => void;

let registration: ServiceWorkerRegistration | null = null;
let status: AppUpdateStatus = 'idle';
let applying = false;
const listeners = new Set<Listener>();

const publish = (next: AppUpdateStatus) => {
  status = next;
  listeners.forEach((listener) => listener(status));
};

const watchInstalling = (worker: ServiceWorker | null) => {
  if (!worker) return;
  worker.addEventListener('statechange', () => {
    if (worker.state !== 'installed') return;
    publish(navigator.serviceWorker.controller ? 'update-ready' : 'up-to-date');
  });
};

export const subscribeToAppUpdates = (listener: Listener): (() => void) => {
  listeners.add(listener);
  listener(status);
  return () => listeners.delete(listener);
};

export const checkForAppUpdate = async (): Promise<void> => {
  if (!registration) {
    publish('error');
    return;
  }
  publish('checking');
  try {
    await registration.update();
    if (registration.waiting) publish('update-ready');
    else if (!registration.installing) publish('up-to-date');
  } catch {
    publish('error');
  }
};

export const applyAppUpdate = (): void => {
  if (!registration?.waiting) {
    publish('error');
    return;
  }
  applying = true;
  registration.waiting.postMessage({ type: 'SKIP_WAITING' });
};

export const registerServiceWorker = (): void => {
  if (import.meta.env.DEV || !('serviceWorker' in navigator)) return;

  const base = import.meta.env.BASE_URL;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .then((nextRegistration) => {
        registration = nextRegistration;
        if (registration.waiting) publish('update-ready');
        watchInstalling(registration.installing);
        registration.addEventListener('updatefound', () =>
          watchInstalling(registration?.installing ?? null),
        );
      })
      .catch(() => publish('error'));
  });

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!applying) return;
    applying = false;
    window.location.reload();
  });
};
