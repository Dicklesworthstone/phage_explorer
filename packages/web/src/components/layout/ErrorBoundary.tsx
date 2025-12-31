import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import { IconAlertTriangle } from '../ui';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
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

  handleReset = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
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
              We hit an unexpected issue. Your data is safe, but we need to refresh to continue.
            </p>

            {this.state.error && (
              <div className="error-boundary__details">
                <code className="error-boundary__code">
                  {this.state.error.toString()}
                </code>
              </div>
            )}

            <div className="error-boundary__actions">
              <button
                type="button"
                onClick={this.handleReset}
                className="btn btn-primary error-boundary__btn-primary"
              >
                Reload Application
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

export default ErrorBoundary;
