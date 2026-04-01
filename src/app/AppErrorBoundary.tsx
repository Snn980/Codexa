/**
 * @file  app/AppErrorBoundary.tsx
 *
 * React lazy + Suspense içindeki runtime hatalarını yakalar.
 * App.tsx'teki AppErrorBoundary buraya taşındı.
 *
 * Not: Hook API ile error boundary tanımlanamaz — class component zorunlu.
 */

import React from "react";
import { ErrorScreen } from "@/app/screens/BootScreens";

// ─── Tipler ──────────────────────────────────────────────────────────────────

interface Props {
  children: React.ReactNode;
  onRetry:  () => void;
}

interface State {
  hasError: boolean;
  message:  string;
}

// ─── Bileşen ─────────────────────────────────────────────────────────────────

export class AppErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : "Beklenmeyen hata",
    };
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, message: "" });
    this.props.onRetry();
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <ErrorScreen message={this.state.message} onRetry={this.handleRetry} />
      );
    }
    return this.props.children;
  }
}
