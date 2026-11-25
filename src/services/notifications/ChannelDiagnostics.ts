import { captureNotificationDiagnostic, notificationExpoGoHost, safeNativeErrorCode, sanitizedNotificationExceptionChain } from './NotificationDiagnostics';

type ChannelOperation = 'setNotificationChannelAsync' | 'getNotificationChannelAsync' | 'verifyChannel';
export type ChannelFailureDiagnostic = {
  stage: 'channel'; operation: ChannelOperation; nativeModule: 'ExpoNotificationChannelManager';
  exceptionName: string; safeMessage: string; nativeCode: string | null;
  expoGoHost: boolean | 'unknown';
};

export function channelFailureDiagnostic(error: unknown, operation: ChannelOperation): ChannelFailureDiagnostic | undefined {
  if (!__DEV__) return undefined;
  const chain = sanitizedNotificationExceptionChain(error, true);
  const nativeCode = chain.map(item => item.nativeCode).find(code => code !== null) ?? null;
  captureNotificationDiagnostic(error, { stage: 'channel', operation, applicationErrorCode: safeNativeErrorCode(chain[0].nativeCode) ?? 'NATIVE_API_ERROR' });
  return {
    stage: 'channel', operation, nativeModule: 'ExpoNotificationChannelManager',
    exceptionName: chain.find(item => /(?:java|javax|android|expo|com|host)\./.test(item.exceptionName))?.exceptionName ?? chain.at(-1)!.exceptionName,
    safeMessage: chain.at(-1)!.safeMessage, nativeCode, expoGoHost: notificationExpoGoHost(),
  };
}

export class ChannelPreparationError extends Error {
  readonly cause: unknown;
  readonly reminderStage: 'channel' | 'native-module';
  readonly code: string;
  readonly diagnostic?: ChannelFailureDiagnostic;
  constructor(cause: unknown, stage: 'channel' | 'native-module', code: string, diagnostic?: ChannelFailureDiagnostic) {
    super('Android notification channel preparation failed.');
    this.name = 'ChannelPreparationError'; this.cause = cause;
    this.reminderStage = stage; this.code = code; this.diagnostic = diagnostic;
  }
}
