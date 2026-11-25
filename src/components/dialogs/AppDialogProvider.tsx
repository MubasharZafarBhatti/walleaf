import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { colors, radius, spacing, typography } from '../../theme';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export type AppDialogAction = {
  text: string;
  onPress?: () => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'destructive' | 'warning';
};

type DialogOptions = {
  title: string;
  message?: string;
  actions?: AppDialogAction[];
  onCancel?: () => void;
  actionLayout?: 'stacked';
};

export type ConfirmOptions = {
  title: string;
  message: string;
  cancelText?: string;
  confirmText?: string;
  destructive?: boolean;
};

type DialogContextValue = {
  showDialog: (options: DialogOptions) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
  showSuccess: (message: string) => void;
};

const DialogContext = createContext<DialogContextValue | null>(null);

export function AppDialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<DialogOptions | null>(null);
  const [dialogEpoch, setDialogEpoch] = useState(0);
  const current = useRef<DialogOptions | null>(null);
  const [banner, setBanner] = useState<{ message: string } | null>(null);
  const insets = useSafeAreaInsets();
  const { width, height, fontScale } = useWindowDimensions();
  useEffect(() => {
    if (!banner) return;
    const timer = setTimeout(() => setBanner(null), 3500);
    return () => clearTimeout(timer);
  }, [banner]);
  useEffect(() => () => current.current?.onCancel?.(), []);
  const value = useMemo(
    () => {
      const showDialog = (options: DialogOptions) => {
        current.current?.onCancel?.();
        current.current = options;
        setDialogEpoch(epoch => epoch + 1);
        setDialog(options);
      };
      return {
        showDialog,
        showSuccess: (message: string) => setBanner({ message }),
        confirm: (options: ConfirmOptions) => new Promise<boolean>((resolve) => {
          showDialog({
            title: options.title,
            message: options.message,
            onCancel: () => resolve(false),
            actions: [
              { text: options.cancelText ?? 'Edit', onPress: () => resolve(false) },
              { text: options.confirmText ?? 'Continue', variant: options.destructive ? 'destructive' : 'primary', onPress: () => resolve(true) },
            ],
          });
        }),
      };
    },
    [],
  );
  const actions = dialog?.actions?.length
    ? dialog.actions
    : [{ text: 'OK', variant: 'primary' as const }];
  const stacked = dialog?.actionLayout === 'stacked' || actions.length > 2 || actions.some(action => action.text.length > 16) || width < 360 || fontScale > 1.2;
  const availableHeight = Math.max(1, height - insets.top - insets.bottom - 2 * spacing.xl);

  async function pressAction(action: AppDialogAction) {
    if (!current.current || current.current !== dialog) return;
    current.current = null;
    setDialog(null);
    try {
      await action.onPress?.();
    } catch {
      value.showDialog({ title: 'Action could not finish', message: 'Please check your data before trying again.' });
    }
  }

  return (
    <DialogContext.Provider value={value}>
      {children}
      {banner ? (
        <View pointerEvents="none" style={[styles.banner, { top: insets.top + spacing.sm }]}>
          <Text accessibilityRole="alert" accessibilityLiveRegion="polite" style={styles.bannerText}>{banner.message}</Text>
        </View>
      ) : null}
      <Modal
        transparent
        visible={!!dialog}
        animationType="fade"
        onRequestClose={() => {
          const pending = current.current;
          current.current = null;
          setDialog(null);
          pending?.onCancel?.();
        }}
      >
        <View style={[styles.overlay, { paddingTop: spacing.xl + insets.top, paddingBottom: spacing.xl + insets.bottom, paddingLeft: spacing.xl + insets.left, paddingRight: spacing.xl + insets.right }]}>
          <View testID="sage-dialog-card" style={[styles.card, { maxHeight: availableHeight }]}>
            <ScrollView key={dialogEpoch} testID="sage-dialog-content" style={styles.content} contentContainerStyle={styles.contentPadding} keyboardShouldPersistTaps="handled" horizontal={false} showsVerticalScrollIndicator>
              <Text style={styles.title}>{dialog?.title}</Text>
              {dialog?.message ? (
                <Text style={styles.message}>{dialog.message}</Text>
              ) : null}
              <View testID="sage-dialog-actions" style={[styles.actions, stacked && styles.actionsStacked]}>
                {actions.map((action) => (
                <Pressable
                  key={action.text}
                  accessibilityRole="button"
                  accessibilityLabel={action.text}
                  onPress={() => pressAction(action)}
                  style={[
                    styles.action,
                    stacked ? styles.actionStacked : styles.actionInline,
                    action.variant === 'primary' && styles.primaryAction,
                    action.variant === 'destructive' && styles.destructiveAction,
                    action.variant === 'warning' && styles.warningAction,
                  ]}
                >
                  <Text
                    style={[
                      styles.actionText,
                      action.variant === 'primary' && styles.primaryActionText,
                      action.variant === 'destructive' &&
                        styles.destructiveActionText,
                      action.variant === 'warning' && styles.warningActionText,
                    ]}
                  >
                    {action.text}
                  </Text>
                </Pressable>
                ))}
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </DialogContext.Provider>
  );
}

export function useAppDialog() {
  const value = useContext(DialogContext);
  if (!value) throw new Error('useAppDialog must be used inside AppDialogProvider');
  return value;
}

const styles = StyleSheet.create({
  banner: {
    position: 'absolute', left: spacing.lg, right: spacing.lg,
    backgroundColor: colors.primary, borderRadius: radius.md,
    padding: spacing.md, zIndex: 1000,
  },
  bannerText: { color: colors.surface, textAlign: 'center', fontWeight: '600' },
  overlay: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(38, 51, 45, 0.35)',
    padding: spacing.xl,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  content: { flexGrow: 0, flexShrink: 1 },
  contentPadding: { padding: spacing.xl },
  title: {
    color: colors.text,
    fontSize: typography.section,
    fontWeight: '700',
    marginBottom: spacing.md,
  },
  message: {
    color: colors.muted,
    fontSize: typography.body,
    lineHeight: 23,
    marginBottom: spacing.lg,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
  },
  actionsStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  action: {
    minHeight: 44,
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  actionStacked: {
    width: '100%',
  },
  actionInline: { flex: 1 },
  primaryAction: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  destructiveAction: {
    borderColor: colors.negative,
  },
  warningAction: {
    borderColor: colors.accent,
  },
  actionText: {
    color: colors.primary,
    fontSize: typography.secondary,
    fontWeight: '700',
    flexShrink: 1,
    maxWidth: '100%',
    textAlign: 'center',
  },
  primaryActionText: {
    color: colors.surface,
  },
  destructiveActionText: {
    color: colors.negative,
  },
  warningActionText: {
    color: colors.warning,
  },
});
