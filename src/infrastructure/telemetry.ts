import { ApplicationInsights, type ITelemetryItem } from '@microsoft/applicationinsights-web';

import { APP_VERSION, BUILD_SHA } from '../release';

const TELEMETRY_OPT_OUT_KEY = 'quartz.telemetry.opted-out';
const TELEMETRY_COOKIE_NAMES = ['ai_user', 'ai_session', 'ai_authUser'];
const MAX_PROPERTY_LENGTH = 160;

export type TelemetryProperties = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

interface TelemetryCookieManager {
  setEnabled(value: boolean): void;
  purge(name: string, path?: string): boolean;
}

interface TelemetryClient {
  loadAppInsights(): void;
  addTelemetryInitializer(initializer: (item: ITelemetryItem) => boolean | void): unknown;
  trackPageView(pageView: { readonly name: string; readonly uri: string }): void;
  trackEvent(
    event: { readonly name: string },
    properties?: Record<string, string | number | boolean>,
  ): void;
  trackMetric(
    metric: { readonly name: string; readonly average: number },
    properties?: Record<string, string | number | boolean>,
  ): void;
  trackException(
    exception: { readonly exception: Error },
    properties?: Record<string, string | number | boolean>,
  ): void;
  getCookieMgr(): TelemetryCookieManager;
  unload(isAsync?: boolean): unknown;
}

export interface Telemetry {
  isAvailable(): boolean;
  isEnabled(): boolean;
  setEnabled(enabled: boolean): Promise<void>;
  trackPageView(name: string): void;
  trackEvent(name: string, properties?: TelemetryProperties): void;
  trackMetric(name: string, value: number, properties?: TelemetryProperties): void;
  trackException(error: unknown, properties?: TelemetryProperties): void;
}

interface TelemetryOptions {
  readonly connectionString?: string;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  readonly clientFactory?: (connectionString: string) => TelemetryClient;
  readonly location?: Pick<Location, 'origin' | 'pathname'>;
  readonly eventTarget?: Pick<Window, 'addEventListener' | 'removeEventListener'> | null;
}

const sanitizeProperties = (
  properties: TelemetryProperties = {},
): Record<string, string | number | boolean> => {
  const sanitized: Record<string, string | number | boolean> = {};
  Object.entries(properties).forEach(([key, value]) => {
    if (value === null || value === undefined) return;
    if (typeof value === 'string') {
      sanitized[key] = value.slice(0, MAX_PROPERTY_LENGTH);
      return;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) return;
    sanitized[key] = value;
  });
  return sanitized;
};

const createSdkClient = (connectionString: string): TelemetryClient =>
  new ApplicationInsights({
    config: {
      connectionString,
      enableAutoRouteTracking: false,
      disableExceptionTracking: true,
      enableUnhandledPromiseRejectionTracking: false,
      autoTrackPageVisitTime: true,
      enableCorsCorrelation: false,
      disableFetchTracking: false,
      cookieCfg: { enabled: true },
    },
  });

class ApplicationInsightsTelemetry implements Telemetry {
  private readonly connectionString: string;
  private readonly storage: TelemetryOptions['storage'];
  private readonly clientFactory: NonNullable<TelemetryOptions['clientFactory']>;
  private readonly location: TelemetryOptions['location'];
  private readonly eventTarget: TelemetryOptions['eventTarget'];
  private client: TelemetryClient | null = null;
  private pageName = 'startup';
  private optedOut: boolean;

  constructor(options: TelemetryOptions) {
    this.connectionString = options.connectionString?.trim() ?? '';
    this.storage = options.storage;
    this.clientFactory = options.clientFactory ?? createSdkClient;
    this.location = options.location;
    this.eventTarget = options.eventTarget;
    this.optedOut = this.readStoredOptOut();
    if (this.isEnabled()) this.initialize();
  }

  isAvailable(): boolean {
    return this.connectionString.length > 0;
  }

  isEnabled(): boolean {
    return this.isAvailable() && !this.optedOut;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (!this.isAvailable()) return;

    if (enabled) {
      this.writeOptOut(false);
      this.initialize();
      this.trackEvent('telemetry_enabled');
      return;
    }

    this.writeOptOut(true);
    this.removeUnhandledErrorListeners();
    const client = this.client;
    this.client = null;
    if (!client) return;

    const cookies = client.getCookieMgr();
    cookies.setEnabled(false);
    TELEMETRY_COOKIE_NAMES.forEach((name) => {
      cookies.purge(name);
      cookies.purge(name, '/');
    });
    await Promise.resolve(client.unload(true));
  }

  trackPageView(name: string): void {
    this.pageName = name;
    this.client?.trackPageView({ name, uri: this.safeUri() });
  }

  trackEvent(name: string, properties?: TelemetryProperties): void {
    this.client?.trackEvent({ name }, sanitizeProperties(properties));
  }

  trackMetric(name: string, value: number, properties?: TelemetryProperties): void {
    if (!Number.isFinite(value)) return;
    this.client?.trackMetric({ name, average: value }, sanitizeProperties(properties));
  }

  trackException(error: unknown, properties?: TelemetryProperties): void {
    const exception = error instanceof Error ? error : new Error(String(error));
    this.client?.trackException({ exception }, sanitizeProperties(properties));
  }

  private initialize(): void {
    if (this.client || !this.isEnabled()) return;

    try {
      const client = this.clientFactory(this.connectionString);
      client.addTelemetryInitializer((item) => {
        item.data = {
          ...item.data,
          appVersion: APP_VERSION,
          buildSha: BUILD_SHA,
        };

        if (item.baseData) {
          if ('uri' in item.baseData) item.baseData.uri = this.safeUri();
          if ('url' in item.baseData) item.baseData.url = this.safeUri();
          if ('refUri' in item.baseData) item.baseData.refUri = '';
        }
      });
      client.loadAppInsights();
      this.client = client;
      this.addUnhandledErrorListeners();
    } catch {
      this.client = null;
    }
  }

  private safeUri(): string {
    const origin = this.location?.origin ?? '';
    const pathname = this.location?.pathname ?? '/';
    return `${origin}${pathname}#/${this.pageName}`;
  }

  private readonly onUnhandledError = (event: Event): void => {
    const error = event instanceof ErrorEvent ? event.error : null;
    this.trackException(new Error('Unhandled browser error'), {
      operation: 'unhandled_error',
      errorType: error instanceof Error ? error.name : 'Error',
    });
  };

  private readonly onUnhandledRejection = (event: Event): void => {
    const reason = event instanceof PromiseRejectionEvent ? event.reason : null;
    this.trackException(new Error('Unhandled promise rejection'), {
      operation: 'unhandled_rejection',
      errorType: reason instanceof Error ? reason.name : typeof reason,
    });
  };

  private addUnhandledErrorListeners(): void {
    this.eventTarget?.addEventListener('error', this.onUnhandledError);
    this.eventTarget?.addEventListener('unhandledrejection', this.onUnhandledRejection);
  }

  private removeUnhandledErrorListeners(): void {
    this.eventTarget?.removeEventListener('error', this.onUnhandledError);
    this.eventTarget?.removeEventListener('unhandledrejection', this.onUnhandledRejection);
  }

  private readStoredOptOut(): boolean {
    try {
      return this.storage?.getItem(TELEMETRY_OPT_OUT_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private writeOptOut(optedOut: boolean): void {
    this.optedOut = optedOut;
    try {
      if (optedOut) this.storage?.setItem(TELEMETRY_OPT_OUT_KEY, 'true');
      else this.storage?.removeItem(TELEMETRY_OPT_OUT_KEY);
    } catch {
      // A blocked preference store must not interfere with Quartz.
    }
  }
}

const noopTelemetry: Telemetry = {
  isAvailable: () => false,
  isEnabled: () => false,
  setEnabled: async () => undefined,
  trackPageView: () => undefined,
  trackEvent: () => undefined,
  trackMetric: () => undefined,
  trackException: () => undefined,
};

export const createTelemetry = (options: TelemetryOptions = {}): Telemetry =>
  new ApplicationInsightsTelemetry({
    connectionString:
      options.connectionString ?? import.meta.env.VITE_APPLICATIONINSIGHTS_CONNECTION_STRING,
    storage: options.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage),
    clientFactory: options.clientFactory,
    location: options.location ?? (typeof window === 'undefined' ? undefined : window.location),
    eventTarget:
      options.eventTarget === undefined
        ? typeof window === 'undefined'
          ? undefined
          : window
        : (options.eventTarget ?? undefined),
  });

export const createNoopTelemetry = (): Telemetry => noopTelemetry;
