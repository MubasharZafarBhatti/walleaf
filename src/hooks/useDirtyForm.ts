import { useEffect, useRef } from 'react';
import { useNavigation } from '@react-navigation/native';
import { BackHandler } from 'react-native';
import { useAppDialog } from '../components/dialogs/AppDialogProvider';

export function useDirtyForm(dirty: boolean, isSaving: () => boolean) {
  const navigation = useNavigation();
  const { confirm } = useAppDialog();
  const bypass = useRef(false);
  const pending = useRef(false);

  async function discard(action: () => void) {
    if (isSaving() || pending.current) return;
    pending.current = true;
    try {
      if (!dirty || await confirm({
        title: 'Discard changes?', message: 'You have unsaved changes.',
        cancelText: 'Keep Editing', confirmText: 'Discard', destructive: true,
      })) action();
    } finally {
      pending.current = false;
    }
  }

  function leave(action: () => void) {
    bypass.current = true;
    try { action(); } finally { bypass.current = false; }
  }

  useEffect(() => navigation.addListener('beforeRemove', (event) => {
    if (bypass.current || (!dirty && !isSaving())) return;
    event.preventDefault();
    void discard(() => leave(() => navigation.dispatch(event.data.action)));
  }));

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!navigation.isFocused() || bypass.current || (!dirty && !isSaving())) return false;
      void discard(() => leave(() => navigation.canGoBack() ? navigation.goBack() : BackHandler.exitApp()));
      return true;
    });
    return () => subscription.remove();
  });
  return { discard, leave };
}
