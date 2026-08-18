import { useMemo, useState } from 'react';

import type { RunEvent, RunState } from '../../domain/types';
import { formatTimeInZone } from '../format';
import {
  fromLocalDateTimeValue,
  getTransitionContext,
  toLocalDateTimeValue,
} from '../timeline';

export interface TransitionTimeDialogProps {
  readonly state: RunState;
  readonly transition: RunEvent;
  readonly observedAt: Date;
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSave: (correctedAt: Date) => Promise<void>;
}

export const TransitionTimeDialog = ({
  state,
  transition,
  observedAt,
  busy,
  onClose,
  onSave,
}: TransitionTimeDialogProps) => {
  const zone = state.timetable.timezone;
  const context = useMemo(
    () => getTransitionContext(state, transition.transitionId, observedAt),
    [state, transition.transitionId, observedAt],
  );
  const [value, setValue] = useState(() => toLocalDateTimeValue(transition.occurredAt, zone));
  const [error, setError] = useState<string | null>(null);

  if (!context) return null;
  const isInitialStart = transition.seq === 1 && transition.type === 'started';
  const minimum = toLocalDateTimeValue(new Date(context.minimum.getTime() + 59_999), zone);
  const maximum = toLocalDateTimeValue(context.maximum, zone);

  const save = async () => {
    const correctedAt = fromLocalDateTimeValue(value, zone);
    if (!correctedAt) {
      setError('Enter a valid local date and time.');
      return;
    }
    if (
      correctedAt.getTime() < context.minimum.getTime() ||
      correctedAt.getTime() > context.maximum.getTime()
    ) {
      setError(`Choose a time between ${formatTimeInZone(context.minimum, zone)} and ${formatTimeInZone(context.maximum, zone)}.`);
      return;
    }
    setError(null);
    await onSave(correctedAt);
  };

  return (
    <div className="modal-backdrop">
      <section
        className="modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="correction-title"
      >
        <h2 id="correction-title">
          {isInitialStart ? 'Correct day start' : 'Correct changeover'}
        </h2>
        <p className="modal-sheet__meta">
          {isInitialStart ? (
            <>When did <strong>{context.toLabel}</strong> actually start?</>
          ) : (
            <>When did <strong>{context.fromLabel}</strong> change to{' '}
              <strong>{context.toLabel}</strong>?</>
          )}
        </p>
        <label className="field">
          <span>{isInitialStart ? 'Actual day start time' : 'Actual changeover time'}</span>
          <input
            type="datetime-local"
            value={value}
            min={minimum}
            max={maximum}
            disabled={busy}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <p className="field__hint">
          Valid from {formatTimeInZone(context.minimum, zone)} through{' '}
          {formatTimeInZone(context.maximum, zone)} · {zone}
        </p>
        {error && <p className="error-note" role="alert">{error}</p>}
        <div className="modal-sheet__actions">
          <button type="button" className="button button--ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button button--primary" disabled={busy} onClick={() => void save()}>
            Save correction
          </button>
        </div>
      </section>
    </div>
  );
};
