jest.mock('expo-notifications', () => ({
  addPushTokenListener: jest.fn(),
  getDevicePushTokenAsync: jest.fn(),
  getExpoPushTokenAsync: jest.fn(),
  IosAuthorizationStatus: { DENIED: 1, AUTHORIZED: 2, PROVISIONAL: 3, EPHEMERAL: 4 },
  AndroidImportance: { DEFAULT: 3 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  getAllScheduledNotificationsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  cancelScheduledNotificationAsync: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  setNotificationHandler: jest.fn(),
}));

jest.mock('expo-notifications/build/NotificationPermissions', () => ({
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
}));
jest.mock('expo-notifications/build/getAllScheduledNotificationsAsync', () => ({
  getAllScheduledNotificationsAsync: jest.fn(),
}));
jest.mock('expo-notifications/build/scheduleNotificationAsync', () => ({
  scheduleNotificationAsync: jest.fn(),
}));
jest.mock('expo-notifications/build/cancelScheduledNotificationAsync', () => ({
  cancelScheduledNotificationAsync: jest.fn(),
}));
jest.mock('expo-notifications/build/setNotificationChannelAsync', () => ({
  setNotificationChannelAsync: jest.fn(),
}));
jest.mock('expo-notifications/build/getNotificationChannelAsync', () => ({ getNotificationChannelAsync: jest.fn(async () => null) }));
jest.mock('expo-notifications/build/NotificationsHandler', () => ({
  setNotificationHandler: jest.fn(),
}));
jest.mock('expo-notifications/build/NotificationsEmitter', () => ({
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponse: jest.fn(() => null),
  clearLastNotificationResponse: jest.fn(),
}));
