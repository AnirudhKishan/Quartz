import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { createServices } from './application/bootstrap';
import { IndexedDbRepository } from './infrastructure/indexedDbRepository';
import { registerServiceWorker } from './infrastructure/serviceWorker';
import { createTelemetry } from './infrastructure/telemetry';
import { loadBundledTimetables } from './infrastructure/timetableAssets';
import { AppProvider } from './ui/store';
import './ui/styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

const services = createServices(new IndexedDbRepository());
const bundledTimetables = loadBundledTimetables();
const telemetry = createTelemetry();

createRoot(container).render(
  <StrictMode>
    <AppProvider
      services={services}
      bundledTimetables={bundledTimetables}
      telemetry={telemetry}
    >
      <App />
    </AppProvider>
  </StrictMode>,
);

registerServiceWorker();
