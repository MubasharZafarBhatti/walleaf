import type { AppDb } from '../../database/database';
import * as repo from '../../database/repositories/repositories';
import type { Settings } from '../../types/models';
import { disableLocalReminders, enableLocalReminders, type NotificationBoundary } from './NotificationService';

export function shouldIntroduceReminders(settings: Pick<Settings, 'setup_complete' | 'notifications_enabled' | 'notifications_intro_answered'>, homeReady: boolean): boolean {
  return homeReady && settings.setup_complete === 'true' && settings.notifications_intro_answered !== 'true' && settings.notifications_enabled !== 'true';
}
const answering = new WeakMap<AppDb, Promise<void>>();
export function answerReminderIntroduction(db: AppDb, enabled: boolean, boundary?: NotificationBoundary): Promise<void> {
  const pending = answering.get(db); if (pending) return pending;
  const next = (async () => {
    const settings = await repo.getSettings(db);
    if (settings.setup_complete !== 'true') return;
    if (settings.notifications_intro_answered === 'true') return;
    // A Settings choice may have been made while the introduction was visible.
    if (settings.notifications_enabled === 'true') { await repo.setSetting(db, 'notifications_intro_answered', 'true'); return; }
    if (enabled) await enableLocalReminders(db, boundary);
    else await disableLocalReminders(db, boundary); // No permission request.
  })();
  answering.set(db, next); void next.finally(() => answering.delete(db)).catch(() => {}); return next;
}
