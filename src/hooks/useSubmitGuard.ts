import { useRef, useState } from 'react';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';

/** Keep validation, confirmations and the write inside submit. Call saved only after the write commits. */
export function useSubmitGuard(refresh: () => Promise<void>) {
  const lock = useRef(false);
  const completed = useRef(false);
  const refreshPending = useRef(false);
  const [saving, setSaving] = useState(false);
  const { showDialog, showSuccess } = useAppDialog();

  async function refreshOnly() {
    try {
      await refresh();
      refreshPending.current = false;
    } catch {
      refreshPending.current = true;
      showDialog({
        title: 'Saved, but refresh failed',
        message: 'Your changes were saved. Do not enter them again. Retry only reloads the screen.',
        actions: [{ text: 'Later' }, { text: 'Retry refresh', onPress: refreshOnly, variant: 'primary' }],
      });
    }
  }

  async function submit(work: () => Promise<void>) {
    if (lock.current || completed.current) return;
    lock.current = true;
    setSaving(true);
    try {
      // A stale screen may retry loading, never repeat the completed write.
      if (refreshPending.current) await refreshOnly();
      else await work();
    } catch {
      showDialog({ title: 'Could not save', message: 'Your input has been kept. Please check the details and try again.' });
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }

  async function saved(message: string, onSaved: () => void, leave = false) {
    completed.current = true;
    showSuccess(message);
    try {
      onSaved();
    } catch {
      showDialog({ title: 'Saved', message: 'Your changes were saved, but the screen could not update. Reopen this screen; do not enter the same changes again.' });
      return;
    }
    completed.current = leave;
    await refreshOnly();
  }

  return { saving, submit, saved, isSaving: () => lock.current };
}
