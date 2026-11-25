import { act, createElement } from 'react';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { Appearance, AppState, type AppStateStatus } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import App from '../../App';

jest.mock('expo-status-bar', () => ({ StatusBar: Object.assign(() => null, { setStyle: jest.fn(), setHidden: jest.fn() }) }));
jest.mock('expo-system-ui', () => ({ setBackgroundColorAsync: jest.fn(async () => {}) }));
jest.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: 'RootView' }));
jest.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: 'SafeAreaProvider' }));
jest.mock('../hooks/useAppData', () => ({ AppDataProvider: 'AppDataProvider' }));
jest.mock('../components/dialogs/AppDialogProvider', () => ({ AppDialogProvider: 'AppDialogProvider' }));
jest.mock('../navigation/AppNavigator', () => ({ AppNavigator: () => null }));
jest.mock('../services/notifications/NotificationService', () => ({ configureNotificationPresentation: jest.fn() }));

test('root reasserts light Sage and readable visible status on mount and every active resume; removes listener', async () => {
  jest.clearAllMocks();
  const appearance = jest.spyOn(Appearance, 'setColorScheme').mockImplementation(() => {});
  let change!: (state: AppStateStatus) => void;
  const remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_name, listener) => { change = listener; return { remove }; });
  let view!: ReactTestRenderer;
  try {
    await act(async () => { view = create(createElement(App)); });
    expect(appearance).toHaveBeenCalledWith('light');
    expect(StatusBar.setHidden).toHaveBeenCalledWith(false);
    expect(StatusBar.setStyle).toHaveBeenCalledWith('dark');
    expect(SystemUI.setBackgroundColorAsync).toHaveBeenCalledWith('#EEF1EA');
    await act(async () => { change('background'); change('inactive'); });
    expect(StatusBar.setStyle).toHaveBeenCalledTimes(1);
    await act(async () => { change('active'); change('active'); });
    expect(StatusBar.setStyle).toHaveBeenCalledTimes(3);
    await act(async () => view.unmount());
    expect(remove).toHaveBeenCalledTimes(1);
  } finally { jest.restoreAllMocks(); }
});
