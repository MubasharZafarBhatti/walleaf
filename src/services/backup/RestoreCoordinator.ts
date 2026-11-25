/** Post-commit failures must never look like a failed financial restore, and
 * recovery callbacks must only refresh/reconcile, never repeat replacement. */
export async function coordinateRestore(steps: {
  pause: () => Promise<{ release: (revoke: boolean) => void }>;
  write: () => Promise<void>;
  refresh: () => Promise<void>;
  reconcile: () => Promise<boolean>;
}) {
  const lease = await steps.pause();
  try { await steps.write(); }
  catch (error) { lease.release(false); throw error; }
  lease.release(true);
  let refreshFailed = false;
  let notificationsFailed = false;
  try { await steps.refresh(); } catch { refreshFailed = true; }
  try { notificationsFailed = !await steps.reconcile(); } catch { notificationsFailed = true; }
  return { committed: true as const, refreshFailed, notificationsFailed };
}
