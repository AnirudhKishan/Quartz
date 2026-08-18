import { useState } from 'react';

import { navigate } from '../router';
import { useApp } from '../store';

export const ClearDataControl = ({ compact = false }: { readonly compact?: boolean }) => {
  const { busy, clearAllData } = useApp();
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <button
        type="button"
        className={compact ? 'menu-action menu-action--danger' : 'button button--danger'}
        disabled={busy}
        onClick={() => setConfirming(true)}
      >
        Clear all local data
      </button>
      {confirming && (
        <div className="modal-backdrop">
          <section
            className="modal-sheet"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="clear-data-title"
          >
            <h2 id="clear-data-title">Clear all local data?</h2>
            <p className="modal-sheet__meta">
              This permanently removes every timetable, run, event, report, and skipped-day
              decision stored on this device. It cannot be undone.
            </p>
            <div className="modal-sheet__actions">
              <button type="button" className="button button--ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="button button--danger"
                disabled={busy}
                onClick={() => {
                  void clearAllData().then((cleared) => {
                    if (cleared) navigate({ kind: 'select' });
                  });
                }}
              >
                Permanently clear data
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
};
