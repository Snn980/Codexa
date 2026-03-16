// src/navigation/NavigationErrorBoundary.tsx
//
// Sorun: Navigation error boundary yok → ekran hatası tüm uygulamayı çökertir.
// Çözüm: Class component ErrorBoundary — sadece navigation tree'yi yakalar.

import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';

interface Props {
  children: React.ReactNode;
  /** Hata loglanacak servis — Sentry, Datadog vs. inject edilebilir */
  onError?: (error: Error, info: React.ErrorInfo) => void;
}

interface State {
  hasError: boolean;
  error:    Error | null;
}

export class NavigationErrorBoundary extends React.Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Inject edilen logger — Sentry, console, vs.
    this.props.onError?.(error, info);
    if (__DEV__) {
      console.error('[NavigationErrorBoundary]', error, info.componentStack);
    }
  }

  private handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <View style={styles.container} testID="nav-error-boundary">
        <Text style={styles.title}>Bir şeyler yanlış gitti</Text>
        {__DEV__ && (
          <Text style={styles.message} numberOfLines={5}>
            {this.state.error?.message}
          </Text>
        )}
        <TouchableOpacity
          style={styles.button}
          onPress={this.handleReset}
          testID="nav-error-retry-button"
        >
          <Text style={styles.buttonText}>Tekrar Dene</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

// ─── Suspense fallback (lazy screen yükleme sırasında) ────────────────────────

export function ScreenLoadingFallback(): React.JSX.Element {
  return (
    <View style={styles.container} testID="screen-loading-fallback">
      {/* Minimal loading — splash ile aynı renk, janky beyaz flash yok */}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex:            1,
    backgroundColor: '#0f0f0f',
    alignItems:      'center',
    justifyContent:  'center',
    padding:         24,
  },
  title: {
    color:      '#fff',
    fontSize:   18,
    fontWeight: '600',
    marginBottom: 12,
  },
  message: {
    color:        '#999',
    fontSize:     12,
    fontFamily:   'monospace',
    marginBottom: 24,
    textAlign:    'center',
  },
  button: {
    backgroundColor: '#7c6af7',
    paddingHorizontal: 24,
    paddingVertical:   12,
    borderRadius:      8,
  },
  buttonText: {
    color:      '#fff',
    fontWeight: '600',
  },
});
