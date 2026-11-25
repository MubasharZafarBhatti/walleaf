import { AndroidImportance } from 'expo-notifications/build/NotificationChannelManager.types';
import { IosAuthorizationStatus } from 'expo-notifications/build/NotificationPermissions.types';
import { SchedulableTriggerInputTypes } from 'expo-notifications/build/Notifications.types';
import type * as Permissions from 'expo-notifications/build/NotificationPermissions';
import type * as Handler from 'expo-notifications/build/NotificationsHandler';
import type * as Emitter from 'expo-notifications/build/NotificationsEmitter';
import type * as Scheduler from 'expo-notifications/build/scheduleNotificationAsync';
import type * as Channels from 'expo-notifications/build/setNotificationChannelAsync';
import type * as Categories from 'expo-notifications/build/setNotificationCategoryAsync';

// Guarded leaf loads avoid both requireNativeModule failures at application
// startup and the package barrel's remote push-token auto-registration.
export const localNotificationApi = {
  AndroidImportance, IosAuthorizationStatus, SchedulableTriggerInputTypes,
  async getPermissionsAsync(...args: Parameters<typeof Permissions.getPermissionsAsync>) {
    return (await import('expo-notifications/build/NotificationPermissions')).getPermissionsAsync(...args);
  },
  async requestPermissionsAsync(...args: Parameters<typeof Permissions.requestPermissionsAsync>) {
    return (await import('expo-notifications/build/NotificationPermissions')).requestPermissionsAsync(...args);
  },
  async getAllScheduledNotificationsAsync() {
    return (await import('expo-notifications/build/getAllScheduledNotificationsAsync')).getAllScheduledNotificationsAsync();
  },
  async scheduleNotificationAsync(...args: Parameters<typeof Scheduler.scheduleNotificationAsync>) {
    return (await import('expo-notifications/build/scheduleNotificationAsync')).scheduleNotificationAsync(...args);
  },
  async cancelScheduledNotificationAsync(identifier: string) {
    return (await import('expo-notifications/build/cancelScheduledNotificationAsync')).cancelScheduledNotificationAsync(identifier);
  },
  async setNotificationChannelAsync(...args: Parameters<typeof Channels.setNotificationChannelAsync>) {
    return (await import('expo-notifications/build/setNotificationChannelAsync')).setNotificationChannelAsync(...args);
  },
  async deleteNotificationChannelAsync(id: string) {
    return (await import('expo-notifications/build/deleteNotificationChannelAsync')).deleteNotificationChannelAsync(id);
  },
  async setNotificationCategoryAsync(...args: Parameters<typeof Categories.setNotificationCategoryAsync>) {
    return (await import('expo-notifications/build/setNotificationCategoryAsync')).setNotificationCategoryAsync(...args);
  },
  async dismissNotificationAsync(identifier: string) {
    return (await import('expo-notifications/build/dismissNotificationAsync')).dismissNotificationAsync(identifier);
  },
  async getPresentedNotificationsAsync() {
    return (await import('expo-notifications/build/getPresentedNotificationsAsync')).getPresentedNotificationsAsync();
  },
  async registerTaskAsync(taskName: string) {
    return (await import('expo-notifications/build/registerTaskAsync')).registerTaskAsync(taskName);
  },
  async getNotificationChannelAsync(id: string) {
    return (await import('expo-notifications/build/getNotificationChannelAsync')).getNotificationChannelAsync(id);
  },
  setNotificationHandler(...args: Parameters<typeof Handler.setNotificationHandler>) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Synchronous native registration must be guarded by its caller.
    const api: typeof Handler = require('expo-notifications/build/NotificationsHandler');
    return api.setNotificationHandler(...args);
  },
  addNotificationResponseReceivedListener(...args: Parameters<typeof Emitter.addNotificationResponseReceivedListener>) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Install the live listener before querying the initial response, inside a guarded boundary.
    const api: typeof Emitter = require('expo-notifications/build/NotificationsEmitter');
    return api.addNotificationResponseReceivedListener(...args);
  },
  getLastNotificationResponse() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- SDK 57 synchronous last-response API, guarded by the navigation coordinator.
    const api: typeof Emitter = require('expo-notifications/build/NotificationsEmitter');
    return api.getLastNotificationResponse();
  },
  clearLastNotificationResponse() {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- SDK 57 synchronous clear API, guarded by the navigation coordinator.
    const api: typeof Emitter = require('expo-notifications/build/NotificationsEmitter');
    return api.clearLastNotificationResponse();
  },
};
