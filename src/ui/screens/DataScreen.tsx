import { useRef, useState } from 'react';

import type { BackupPreview } from '../../application/backupService';
import { isQuartzError } from '../../domain/errors';
import { navigate } from '../router';
import { useApp } from '../store';
import { Screen } from '../components/Screen';

type Status =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'error';
      readonly message: string;
      readonly details: readonly string[];
      readonly existingDataUnchanged: boolean;
    }
  | { readonly kind: 'confirm'; readonly preview: BackupPreview; readonly fileName: string }
  | { readonly kind: 'restored' };

const describe = (error: unknown): { message: string; details: readonly string[] } =>
  isQuartzError(error)
    ? { message: error.message, details: error.details }
    : { message: error instanceof Error ? error.message : String(error), details: [] };

/** `Blob.text` is not available in every runtime Quartz is tested in. */
const readText = (file: File): Promise<string> =>
  typeof file.text === 'function'
    ? file.text()
    : new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ''));
        reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
        reader.readAsText(file);
      });

export const DataScreen = () => {
  const {
    services,
    activeState,
    reload,
    telemetry,
    feedback,
  } = useApp();
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [working, setWorking] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const exportBackup = async () => {
    setWorking(true);
    void feedback.prepare();
    try {
      const json = await services.backups.exportToJson();
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = services.backups.suggestedFileName();
      anchor.click();
      URL.revokeObjectURL(url);
      setStatus({ kind: 'idle' });
      telemetry.trackEvent('backup_exported');
      feedback.play('success');
    } catch (error) {
      telemetry.trackException(new Error('Backup export failed'), { operation: 'backup_exported' });
      setStatus({ kind: 'error', ...describe(error), existingDataUnchanged: true });
      feedback.play('error');
    } finally {
      setWorking(false);
    }
  };

  /** Validate the whole file before offering to replace anything. */
  const choose = async (file: File) => {
    setWorking(true);
    void feedback.prepare();
    try {
      const preview = services.backups.preview(await readText(file));
      setStatus({
        kind: 'confirm',
        preview,
        fileName: file.name,
      });
      telemetry.trackEvent('backup_validated', {
        timetableCount: preview.timetableCount,
        runCount: preview.runCount,
        eventCount: preview.eventCount,
        hasActiveRun: preview.hasActiveRun,
      });
    } catch (error) {
      telemetry.trackException(new Error('Backup validation failed'), {
        operation: 'backup_validated',
      });
      setStatus({ kind: 'error', ...describe(error), existingDataUnchanged: true });
      feedback.play('error');
    } finally {
      setWorking(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const confirmRestore = async (preview: BackupPreview) => {
    setWorking(true);
    void feedback.prepare();
    let restored = false;
    try {
      await services.backups.restore(preview);
      restored = true;
      if (!(await reload())) {
        setStatus({
          kind: 'error',
          message: 'The backup was restored, but Quartz could not reopen the restored data.',
          details: ['Use the recovery options shown by Quartz to restore another backup or retry.'],
          existingDataUnchanged: false,
        });
        feedback.play('error');
        return;
      }
      setStatus({ kind: 'restored' });
      telemetry.trackEvent('backup_restored', {
        timetableCount: preview.timetableCount,
        runCount: preview.runCount,
        eventCount: preview.eventCount,
        hasActiveRun: preview.hasActiveRun,
      });
      feedback.play('success');
    } catch (error) {
      const described = describe(error);
      telemetry.trackException(new Error('Backup restore failed'), {
        operation: 'backup_restored',
      });
      setStatus({
        kind: 'error',
        ...(restored
          ? {
              message: 'The backup was restored, but Quartz could not reopen the restored data.',
              details: [described.message, ...described.details],
            }
          : described),
        existingDataUnchanged: !restored,
      });
      feedback.play('error');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Screen
      title="Backup"
      subtitle="Your plans and recorded days stay on this device. Export them to keep a copy."
      back={{ label: 'Timetables', route: { kind: 'select' } }}
    >
      <section className="card">
        <h2 className="card__title">Where your data lives</h2>
        <p className="card__warning" role="note">
          Quartz keeps timetable names, task names, recorded days, and backups in this
          browser&apos;s storage on this device only. Uninstalling the app, clearing browser storage
          or site data, or losing the device will remove any data that has not been exported.
          Exported backups are the only copies.
        </p>
      </section>

      <section className="card">
        <h2 className="card__title">Export</h2>
        <p className="card__meta">
          Downloads every timetable, day, and recorded step as a versioned JSON file.
        </p>
        <button
          type="button"
          className="button button--primary"
          disabled={working}
          onClick={() => void exportBackup()}
        >
          Export backup
        </button>
      </section>

      <section className="card">
        <h2 className="card__title">Restore</h2>
        <p className="card__warning" role="note">
          Restoring replaces all data currently on this device. Anything not in the backup file will
          be permanently lost.
        </p>
        {activeState && (
          <p className="card__meta">A day is currently running and will be replaced too.</p>
        )}
        <input
          ref={fileInput}
          className="file-input"
          type="file"
          accept="application/json,.json"
          aria-label="Choose a backup file"
          disabled={working}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void choose(file);
          }}
        />
      </section>

      {status.kind === 'error' && (
        <section className="card card--error" role="alert">
          <h2 className="card__title">That backup was not restored</h2>
          <p className="card__meta">{status.message}</p>
          {status.details.length > 0 && (
            <ul className="details">
              {status.details.map((detail) => (
                <li key={detail}>{detail}</li>
              ))}
            </ul>
          )}
          {status.existingDataUnchanged && (
            <p className="card__meta">Your existing data is unchanged.</p>
          )}
        </section>
      )}

      {status.kind === 'confirm' && (
        <section className="card card--accent" role="alertdialog" aria-label="Confirm restore">
          <h2 className="card__title">Replace all data?</h2>
          <p className="card__meta">
            {status.fileName} contains {status.preview.timetableCount} timetables,{' '}
            {status.preview.runCount} days, and {status.preview.eventCount} recorded steps
            {status.preview.hasActiveRun ? ', including a day in progress' : ''}.
          </p>
          <p className="card__warning">
            This permanently deletes everything currently stored on this device.
          </p>
          <button
            type="button"
            className="button button--danger"
            disabled={working}
            onClick={() => void confirmRestore(status.preview)}
          >
            Replace all data
          </button>
          <button
            type="button"
            className="button button--ghost"
            disabled={working}
            onClick={() => setStatus({ kind: 'idle' })}
          >
            Cancel
          </button>
        </section>
      )}

      {status.kind === 'restored' && (
        <section className="card card--accent" role="status">
          <h2 className="card__title">Backup restored</h2>
          <button
            type="button"
            className="button button--primary"
            onClick={() => navigate({ kind: 'select' })}
          >
            Continue
          </button>
        </section>
      )}
    </Screen>
  );
};
