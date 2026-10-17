import { useState } from 'react';

import { AppVersionCard } from '../components/AppVersionCard';
import { Screen } from '../components/Screen';
import { useApp } from '../store';

export const SettingsScreen = () => {
  const {
    activeState,
    feedback,
    feedbackSnapshot,
    setFeedbackEnabled,
    telemetryAvailable,
    telemetryEnabled,
    setTelemetryEnabled,
  } = useApp();
  const [telemetryWorking, setTelemetryWorking] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const { preferences } = feedbackSnapshot;
  const back = activeState
    ? { label: 'Running day', route: { kind: 'run' as const } }
    : { label: 'Timetables', route: { kind: 'select' as const } };

  const previewSound = () => {
    void feedback.prepare();
    feedback.play('complete', 'sound');
  };

  const toggleTelemetry = async () => {
    setTelemetryWorking(true);
    setTelemetryError(null);
    void feedback.prepare();
    try {
      await setTelemetryEnabled(!telemetryEnabled);
      feedback.play('success');
    } catch (error) {
      setTelemetryError(error instanceof Error ? error.message : String(error));
      feedback.play('error');
    } finally {
      setTelemetryWorking(false);
    }
  };

  return (
    <Screen
      title="Settings"
      subtitle="Manage feedback, privacy, and app updates."
      back={back}
    >
      <section className="card">
        <div className="setting-row">
          <div>
            <h2 className="card__title">Haptic feedback</h2>
            <p className="card__meta">
              Brief vibration patterns confirm actions on supported devices.
            </p>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              aria-label="Haptic feedback"
              checked={preferences.haptics}
              onChange={(event) => setFeedbackEnabled('haptics', event.target.checked)}
            />
            <span>{preferences.haptics ? 'On' : 'Off'}</span>
          </label>
        </div>
        <button
          type="button"
          className="button button--secondary"
          disabled={!preferences.haptics}
          onClick={() => feedback.play('success', 'haptics')}
        >
          Preview haptics
        </button>
        {!feedbackSnapshot.hapticsAvailable && (
          <p className="card__warning" role="note">
            This browser does not expose haptic feedback. Actions still work normally.
          </p>
        )}
        {feedbackSnapshot.hapticsIssue && (
          <p className="card__warning" role="status">
            {feedbackSnapshot.hapticsIssue}
          </p>
        )}
      </section>

      <section className="card">
        <div className="setting-row">
          <div>
            <h2 className="card__title">Sound feedback</h2>
            <p className="card__meta">
              Subtle tones distinguish success, completion, undo, and errors.
            </p>
          </div>
          <label className="toggle">
            <input
              type="checkbox"
              aria-label="Sound feedback"
              checked={preferences.sound}
              onChange={(event) => setFeedbackEnabled('sound', event.target.checked)}
            />
            <span>{preferences.sound ? 'On' : 'Off'}</span>
          </label>
        </div>
        <button
          type="button"
          className="button button--secondary"
          disabled={!preferences.sound}
          onClick={previewSound}
        >
          Preview sound
        </button>
        {!feedbackSnapshot.soundAvailable && (
          <p className="card__warning" role="note">
            This browser does not support Quartz sound feedback. Actions still work normally.
          </p>
        )}
        {feedbackSnapshot.soundIssue && (
          <p className="card__warning" role="status">
            {feedbackSnapshot.soundIssue}
          </p>
        )}
      </section>

      {feedbackSnapshot.storageIssue && (
        <section className="card card--error" role="status">
          <h2 className="card__title">Feedback preference issue</h2>
          <p className="card__meta">{feedbackSnapshot.storageIssue}</p>
        </section>
      )}

      <p className="footnote">
        Feedback is on by default and is stored only in this browser. Backup restore and Clear all
        local data do not change these settings. Browser permissions, silent mode, and device
        hardware can still suppress feedback.
      </p>

      <section className="card">
        <h2 className="card__title">Anonymous telemetry</h2>
        <p className="card__meta">
          {telemetryAvailable
            ? `Telemetry is ${telemetryEnabled ? 'on' : 'off'}.`
            : 'Telemetry is unavailable in this build.'}
        </p>
        <p className="card__warning" role="note">
          When on, Quartz sends anonymous browser and session identifiers, screen views, feature
          actions, aggregate measurements, performance data, app version, device information, and
          errors to Azure Application Insights. It does not send timetable names, task names,
          backup contents, raw recorded days, or record identifiers.
        </p>
        {telemetryAvailable && (
          <button
            type="button"
            className={telemetryEnabled ? 'button button--secondary' : 'button button--primary'}
            disabled={telemetryWorking}
            onClick={() => void toggleTelemetry()}
          >
            {telemetryEnabled ? 'Turn telemetry off' : 'Turn telemetry on'}
          </button>
        )}
        {telemetryError && (
          <p className="error-note" role="alert">
            {telemetryError}
          </p>
        )}
        <p className="card__meta">
          This preference is kept separately and is not changed by restoring or clearing Quartz
          data.
        </p>
      </section>

      <AppVersionCard />
    </Screen>
  );
};
