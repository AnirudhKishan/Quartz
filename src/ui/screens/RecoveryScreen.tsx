import type { QuartzError } from '../../domain/errors';
import { useApp } from '../store';
import { Screen } from '../components/Screen';
import { ClearDataControl } from '../components/ClearDataControl';

const guidance = (error: QuartzError): string => {
  switch (error.code) {
    case 'storage-unavailable':
      return 'Quartz stores everything on this device. Private browsing or blocked site data can prevent that. Try a normal window, or allow site data for this address.';
    case 'corrupt-history':
      return 'The recorded history of a day cannot be read back safely, so Quartz will not guess what happened. Restore a backup to continue with known-good data.';
    case 'invalid-timetable':
      return 'A stored timetable failed validation, so it cannot be measured against. Restoring a backup replaces it.';
    default:
      return 'Quartz cannot continue safely with the data currently stored.';
  }
};

/**
 * Blocking failure surface.
 *
 * The spec is explicit that unreadable state must be reported rather than
 * guessed at, so no run action is offered here — only retry and restore.
 */
export const RecoveryScreen = ({ error }: { readonly error: QuartzError }) => {
  const { reload } = useApp();

  return (
    <Screen title="Quartz cannot continue" subtitle={error.message}>
      <section className="card card--error" role="alert">
        <h2 className="card__title">What happened</h2>
        <p className="card__meta">{guidance(error)}</p>
        {error.details.length > 0 && (
          <ul className="details">
            {error.details.map((detail) => (
              <li key={detail}>{detail}</li>
            ))}
          </ul>
        )}
        <p className="card__meta code">{error.code}</p>
      </section>

      <button type="button" className="button button--primary" onClick={() => void reload()}>
        Try again
      </button>
      <a className="button button--secondary" href="#/data">
        Restore from a backup
      </a>
      <ClearDataControl />
    </Screen>
  );
};
