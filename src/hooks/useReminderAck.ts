import { useEffect, useState } from 'react';
import { latestReminderAck, reminderAckLabel, subscribeReminderAcks, type ReminderAck } from '../services/notifications/ReminderActions';
import { displayFullDate } from '../utils/date';

/** "Last reminder (17 Nov 2026): Marked as read · 9:05 AM" for a detail screen. */
export function formatReminderAck(ack: ReminderAck): string {
  const at = new Date(ack.at);
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const day = at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `Last reminder (${displayFullDate(ack.occurrenceDate)}): ${reminderAckLabel(ack.method)} · ${day}, ${time}`;
}

export function useReminderAck(sourceType: 'planned_payment' | 'subscription', sourceId: string | undefined, refreshKey: unknown) {
  const [ack, setAck] = useState<ReminderAck | null>(null);
  // Bumped whenever a response is recorded (button press, swipe found on resume) while the screen is open.
  const [version, setVersion] = useState(0);
  useEffect(() => subscribeReminderAcks(() => setVersion(value => value + 1)), []);
  useEffect(() => {
    if (!sourceId) return;
    let active = true;
    latestReminderAck(sourceType, sourceId).then(value => { if (active) setAck(value); }, () => { if (active) setAck(null); });
    return () => { active = false; };
  }, [sourceType, sourceId, refreshKey, version]);
  return ack;
}
