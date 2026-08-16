import { useRoute } from './ui/router';
import { useApp } from './ui/store';
import { ActiveRunScreen } from './ui/screens/ActiveRunScreen';
import { DataScreen } from './ui/screens/DataScreen';
import { RecoveryScreen } from './ui/screens/RecoveryScreen';
import { ReportsScreen } from './ui/screens/ReportsScreen';
import { RunReportScreen } from './ui/screens/RunReportScreen';
import { SelectionScreen } from './ui/screens/SelectionScreen';
import { TimetableReportScreen } from './ui/screens/TimetableReportScreen';
import { Loading, Screen } from './ui/components/Screen';

export const App = () => {
  const route = useRoute();
  const { phase, blockingError } = useApp();

  if (phase === 'loading') {
    return (
      <Screen title="Quartz">
        <Loading label="Opening your data…" />
      </Screen>
    );
  }

  // Backup stays reachable while blocked: restoring is the documented recovery.
  if (phase === 'blocked' && blockingError && route.kind !== 'data') {
    return <RecoveryScreen error={blockingError} />;
  }

  switch (route.kind) {
    case 'run':
      return <ActiveRunScreen />;
    case 'reports':
      return <ReportsScreen />;
    case 'run-report':
      return <RunReportScreen runId={route.runId} />;
    case 'timetable-report':
      return <TimetableReportScreen timetableId={route.timetableId} />;
    case 'data':
      return <DataScreen />;
    default:
      return <SelectionScreen />;
  }
};
