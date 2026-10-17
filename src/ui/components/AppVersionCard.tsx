import { useEffect, useState } from 'react';

import {
  applyAppUpdate,
  checkForAppUpdate,
  subscribeToAppUpdates,
  type AppUpdateStatus,
} from '../../infrastructure/serviceWorker';
import { BUILD_ID } from '../../release';
import { useApp } from '../store';

const messageFor = (status: AppUpdateStatus): string => {
  switch (status) {
    case 'checking':
      return 'Checking for the latest deployed build…';
    case 'up-to-date':
      return 'This installed build is up to date.';
    case 'update-ready':
      return 'A newer deployed build is ready to apply.';
    case 'error':
      return 'Quartz could not check for an update. Check your connection and try again.';
    default:
      return 'Compare this build with the release identifier provided after deployment.';
  }
};

export const AppVersionCard = () => {
  const [status, setStatus] = useState<AppUpdateStatus>('idle');
  const { telemetry } = useApp();

  useEffect(
    () =>
      subscribeToAppUpdates((nextStatus) => {
        setStatus(nextStatus);
        if (nextStatus !== 'idle' && nextStatus !== 'checking') {
          telemetry.trackEvent('app_update_status', { status: nextStatus });
        }
      }),
    [telemetry],
  );

  return (
    <section className="card">
      <h2 className="card__title">App version</h2>
      <p className="card__meta code">{BUILD_ID}</p>
      <p className="card__meta" role="status">
        {messageFor(status)}
      </p>
      {status === 'update-ready' ? (
        <button
          type="button"
          className="button button--primary"
          onClick={() => {
            telemetry.trackEvent('app_update_applied');
            applyAppUpdate();
          }}
        >
          Apply update
        </button>
      ) : (
        <button
          type="button"
          className="button button--secondary"
          disabled={status === 'checking'}
          onClick={() => {
            telemetry.trackEvent('app_update_check_requested');
            void checkForAppUpdate();
          }}
        >
          Check for updates
        </button>
      )}
    </section>
  );
};
