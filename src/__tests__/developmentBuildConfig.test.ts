import type { ExpoConfig } from 'expo/config';
import base from '../../app.json';
import eas from '../../eas.json';
import notificationsNativeConfig from '../../node_modules/expo-notifications/expo-module.config.json';
import sdkVersions from '../../node_modules/expo/bundledNativeModules.json';
import pkg from '../../package.json';

const resolve: (context: { config: ExpoConfig }) => ExpoConfig = jest.requireActual('../../app.config.js');
const previous = process.env.EXPO_PUBLIC_BUILD_VARIANT;
afterEach(() => { if (previous === undefined) delete process.env.EXPO_PUBLIC_BUILD_VARIANT; else process.env.EXPO_PUBLIC_BUILD_VARIANT = previous; });

test.each([undefined, 'production'])('variant %s retains original native identity and all protected config without mutating app.json', variant => {
  if (variant === undefined) delete process.env.EXPO_PUBLIC_BUILD_VARIANT; else process.env.EXPO_PUBLIC_BUILD_VARIANT = variant;
  const config = structuredClone(base.expo); const original = JSON.stringify(config);
  expect(resolve({ config: config as unknown as ExpoConfig })).toBe(config); expect(JSON.stringify(config)).toBe(original); expect(config.android.package).toBe('com.mubashar.expensetracker');
});
test('explicit development variant isolates Android data/launch scheme and retains light Sage, keyboard, plugins and version', () => {
  process.env.EXPO_PUBLIC_BUILD_VARIANT = 'development'; const config = structuredClone(base.expo); const original = JSON.stringify(config); const development = resolve({ config: config as unknown as ExpoConfig });
  expect(development.name).toBe('Walleaf Dev'); expect(development.scheme).toBe('expense-tracker-dev'); expect(development.android?.package).toBe('com.mubashar.expensetracker.dev'); expect(JSON.stringify(config)).toBe(original);
  expect(development.android).toEqual({ ...config.android, package: 'com.mubashar.expensetracker.dev' }); expect(development.userInterfaceStyle).toBe('light'); expect(development.version).toBe(config.version);
  expect(development.plugins?.slice(0, config.plugins.length)).toEqual(config.plugins);
  expect(development.plugins?.at(-1)).toEqual(['expo-dev-client', { launchMode: 'most-recent', addGeneratedScheme: false }]);
});
test('EAS development profile explicitly selects debug development client while production is preserved', () => {
  expect(eas.build.development).toMatchObject({ developmentClient: true, distribution: 'internal', android: { buildType: 'apk', gradleCommand: ':app:assembleDebug' }, env: { EXPO_PUBLIC_BUILD_VARIANT: 'development' } });
  expect(eas.build).not.toHaveProperty('senior-demo'); // the demo build type was removed
  expect(eas.build.production).toMatchObject({ developmentClient: false, android: { buildType: 'app-bundle' }, env: { EXPO_PUBLIC_BUILD_VARIANT: 'production' } });
});
test('development client matches installed SDK recommendation; notifications retain their autolinked provider declaration', () => {
  expect(pkg.dependencies['expo-dev-client']).toBe(sdkVersions['expo-dev-client']); expect(pkg.dependencies.expo).toBe('~57.0.27'); expect(pkg.dependencies['expo-notifications']).toBe('~57.0.22');
  expect(notificationsNativeConfig.android.modules).toContain('expo.modules.notifications.notifications.channels.AndroidXNotificationsChannelsProvider');
  expect(notificationsNativeConfig.android.modules).toContain('expo.modules.notifications.notifications.channels.NotificationChannelManagerModule');
});
