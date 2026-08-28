import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { IconAlertTriangle } from '../ui';

type ErrorBoundaryFallbackRenderArgs = {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  reset: () => void;
  reload: () => void;
};

interface Props {
  children: ReactNode;
  fallback?: ReactNode | ((args: ErrorBoundaryFallbackRenderArgs) => ReactNode);
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('Uncaught error:', error, errorInfo);
    this.setState({ errorInfo });
    // Here we could log to telemetry service
  }

  handleTryAgain = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  handleReload = (): void => {
    if (typeof window === 'undefined') return;
    window.location.reload();
  };

  private openExternal(url: string): void {
    // Prevent reverse tabnabbing (window.opener) when opening external sites.
    const opened = window.open(url, '_blank', 'noopener,noreferrer');
    if (opened) opened.opener = null;
  }

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        if (typeof this.props.fallback === 'function') {
          return this.props.fallback({
            error: this.state.error,
            errorInfo: this.state.errorInfo,
            reset: this.handleTryAgain,
            reload: this.handleReload,
          });
        }

        return this.props.fallback;
      }

      return (
        <div className="error-boundary">
          <div className="error-boundary__card">
            <div className="error-boundary__icon" aria-hidden="true">
              <IconAlertTriangle size={48} />
            </div>
            <h1 className="error-boundary__title">Something went wrong</h1>
            <p className="error-boundary__message">
              We hit an unexpected issue. Your data is safe. Try again, or reload the app if the error persists.
            </p>

            {(this.state.error || this.state.errorInfo) && (
              <details className="error-boundary__details">
                <summary className="error-boundary__details-summary">Details</summary>
                <pre className="error-boundary__code">{formatErrorDetails(this.state.error, this.state.errorInfo)}</pre>
              </details>
            )}

            <div className="error-boundary__actions">
              <button
                type="button"
                onClick={this.handleTryAgain}
                className="btn btn-primary error-boundary__btn-primary"
              >
                Try Again
              </button>
              <button
                type="button"
                onClick={this.handleReload}
                className="btn btn-ghost error-boundary__btn-secondary"
              >
                Reload App
              </button>
              <button
                type="button"
                onClick={() => this.openExternal('https://github.com/Dicklesworthstone/phage_explorer/issues')}
                className="btn btn-ghost error-boundary__btn-secondary"
              >
                Report Issue
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function formatErrorDetails(error: Error | null, errorInfo: ErrorInfo | null): string {
  const parts: string[] = [];
  if (error) {
    parts.push(error.stack ?? error.toString());
  }
  const componentStack = errorInfo?.componentStack?.trim();
  if (componentStack) {
    parts.push(`Component stack:\n${componentStack}`);
  }
  return parts.length ? parts.join('\n\n') : 'No error details are available.';
}

export default ErrorBoundary;
