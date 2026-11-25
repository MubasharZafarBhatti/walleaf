import { Platform } from 'react-native';
import { localNotificationApi } from './LocalNotificationApi';
import { handleReminderAction } from './ReminderActions';
import { REMINDER_ACTION_TASK } from './ReminderConstants';

/**
 * Android runs this task for notification buttons pressed while the app is in
 * the background or closed (Got it / Snooze). It must be defined
 * at module scope from index.ts so a headless JS start can find it.
 */
export function registerReminderActionTask() {
  if (Platform.OS === 'web') return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Guarded native load; reminders stay optional.
    const TaskManager: typeof import('expo-task-manager') = require('expo-task-manager');
    if (!TaskManager.isTaskDefined(REMINDER_ACTION_TASK)) {
      TaskManager.defineTask(REMINDER_ACTION_TASK, async ({ data, error }) => {
        if (error || !data || typeof data !== 'object' || !('actionIdentifier' in data)) return;
        try { await handleReminderAction(data); } catch { /* Reminder side effect only; never financial. */ }
      });
    }
    void localNotificationApi.registerTaskAsync(REMINDER_ACTION_TASK).catch(() => {});
  } catch { /* Unsupported runtime (for example Expo Go limitations): buttons fall back to the foreground listener. */ }
}
