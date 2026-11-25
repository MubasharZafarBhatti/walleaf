import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { Appearance, AppState } from 'react-native';
import * as SystemUI from 'expo-system-ui';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppDataProvider } from './src/hooks/useAppData';
import { AppNavigator } from './src/navigation/AppNavigator';
import { AppDialogProvider } from './src/components/dialogs/AppDialogProvider';
import { configureNotificationPresentation } from './src/services/notifications/NotificationService';
import { colors } from './src/theme';
import { holdStartupSplash } from './src/components/StartupSplash';

holdStartupSplash();
configureNotificationPresentation();
// Sage is deliberately light, including Android's native window/system surfaces.
export function reassertSageSystemUI() {
  Appearance.setColorScheme('light');
  StatusBar.setHidden(false);
  StatusBar.setStyle('dark');
  void SystemUI.setBackgroundColorAsync(colors.background).catch(() => {});
}
reassertSageSystemUI();

export default function App() {
  useEffect(() => {
    reassertSageSystemUI();
    const listener = AppState.addEventListener('change', (state) => {
      if (state === 'active') reassertSageSystemUI();
    });
    return () => listener.remove();
  }, []);
  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: colors.background }}>
      <SafeAreaProvider>
        <AppDataProvider>
          <AppDialogProvider>
            <AppNavigator />
            <StatusBar hidden={false} style="dark" />
          </AppDialogProvider>
        </AppDataProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
