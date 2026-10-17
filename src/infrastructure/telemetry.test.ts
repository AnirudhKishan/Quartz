import type { ITelemetryItem } from '@microsoft/applicationinsights-web';
import { describe, expect, it, vi } from 'vitest';

import { createTelemetry } from './telemetry';

const createStorage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
};

const createClient = () => {
  let initializer: ((item: ITelemetryItem) => boolean | void) | undefined;
  const cookieManager = {
    setEnabled: vi.fn(),
    purge: vi.fn(() => true),
  };
  const client = {
    loadAppInsights: vi.fn(),
    addTelemetryInitializer: vi.fn((next: (item: ITelemetryItem) => boolean | void) => {
      initializer = next;
    }),
    trackPageView: vi.fn(),
    trackEvent: vi.fn(),
    trackMetric: vi.fn(),
    trackException: vi.fn(),
    getCookieMgr: vi.fn(() => cookieManager),
    unload: vi.fn(),
  };
  return { client, getInitializer: () => initializer };
};

describe('Application Insights telemetry', () => {
  it('sanitizes routes, adds release metadata, and drops invalid properties', () => {
    const { client, getInitializer } = createClient();
    const telemetry = createTelemetry({
      connectionString: 'InstrumentationKey=test',
      storage: createStorage(),
      clientFactory: () => client,
      location: { origin: 'https://example.test', pathname: '/Quartz/' },
      eventTarget: null,
    });

    telemetry.trackPageView('screen_run-report');
    telemetry.trackEvent('run_report_viewed', {
      safeCount: 3,
      invalidNumber: Number.NaN,
      omitted: null,
      longText: 'x'.repeat(200),
    });

    expect(client.trackPageView).toHaveBeenCalledWith({
      name: 'screen_run-report',
      uri: 'https://example.test/Quartz/#/screen_run-report',
    });
    expect(client.trackEvent).toHaveBeenCalledWith(
      { name: 'run_report_viewed' },
      { safeCount: 3, longText: 'x'.repeat(160) },
    );

    const item: ITelemetryItem = {
      name: 'exception',
      data: {},
      baseData: {
        uri: 'https://example.test/Quartz/#/reports/run/private-id',
        url: 'https://example.test/Quartz/#/reports/run/private-id',
        refUri: 'https://private.example/',
      },
    };
    getInitializer()?.(item);

    expect(item.data).toMatchObject({ appVersion: expect.any(String), buildSha: expect.any(String) });
    expect(item.baseData).toMatchObject({
      uri: 'https://example.test/Quartz/#/screen_run-report',
      url: 'https://example.test/Quartz/#/screen_run-report',
      refUri: '',
    });
  });

  it('persists opt-out, purges identifiers, and stays disabled until re-enabled', async () => {
    const storage = createStorage();
    const first = createClient();
    const telemetry = createTelemetry({
      connectionString: 'InstrumentationKey=test',
      storage,
      clientFactory: () => first.client,
      location: { origin: 'https://example.test', pathname: '/Quartz/' },
      eventTarget: null,
    });

    await telemetry.setEnabled(false);

    expect(telemetry.isEnabled()).toBe(false);
    expect(storage.getItem('quartz.telemetry.opted-out')).toBe('true');
    expect(first.client.getCookieMgr().setEnabled).toHaveBeenCalledWith(false);
    expect(first.client.getCookieMgr().purge).toHaveBeenCalledWith('ai_user');
    expect(first.client.getCookieMgr().purge).toHaveBeenCalledWith('ai_session', '/');
    expect(first.client.unload).toHaveBeenCalledWith(true);

    const disabledClient = createClient();
    const reopened = createTelemetry({
      connectionString: 'InstrumentationKey=test',
      storage,
      clientFactory: () => disabledClient.client,
      location: { origin: 'https://example.test', pathname: '/Quartz/' },
      eventTarget: null,
    });
    expect(disabledClient.client.loadAppInsights).not.toHaveBeenCalled();

    await reopened.setEnabled(true);
    expect(reopened.isEnabled()).toBe(true);
    expect(storage.getItem('quartz.telemetry.opted-out')).toBeNull();
    expect(disabledClient.client.loadAppInsights).toHaveBeenCalledOnce();
    expect(disabledClient.client.trackEvent).toHaveBeenCalledWith(
      { name: 'telemetry_enabled' },
      {},
    );
  });

  it('is a no-op when no production connection string is configured', async () => {
    const client = createClient();
    const telemetry = createTelemetry({
      connectionString: '',
      storage: createStorage(),
      clientFactory: () => client.client,
      location: { origin: 'http://localhost', pathname: '/' },
      eventTarget: null,
    });

    telemetry.trackEvent('ignored');
    await telemetry.setEnabled(true);

    expect(telemetry.isAvailable()).toBe(false);
    expect(telemetry.isEnabled()).toBe(false);
    expect(client.client.loadAppInsights).not.toHaveBeenCalled();
    expect(client.client.trackEvent).not.toHaveBeenCalled();
  });
});
