import type { ReactNode } from 'react';

import { routeToHash, type Route } from '../router';

export interface ScreenProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly back?: { readonly label: string; readonly route: Route };
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}

export const Screen = ({ title, subtitle, back, children, footer }: ScreenProps) => (
  <div className="screen">
    <header className="screen__header">
      {back && (
        <a className="screen__back" href={routeToHash(back.route)}>
          ← {back.label}
        </a>
      )}
      <h1 className="screen__title">{title}</h1>
      {subtitle && <p className="screen__subtitle">{subtitle}</p>}
    </header>
    <main className="screen__body">{children}</main>
    {footer && <footer className="screen__footer">{footer}</footer>}
  </div>
);

export const EmptyState = ({ children }: { readonly children: ReactNode }) => (
  <p className="empty">{children}</p>
);

export const Loading = ({ label = 'Loading…' }: { readonly label?: string }) => (
  <p className="empty" role="status">
    {label}
  </p>
);

export const ErrorNote = ({ error }: { readonly error: Error }) => (
  <p className="error-note" role="alert">
    {error.message}
  </p>
);
