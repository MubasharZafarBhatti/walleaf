import { Platform } from 'react-native';

export type SanitizedNotificationException = { exceptionName: string; safeMessage: string; nativeCode: string | null };
export type NotificationDiagnostic = {
  stage: string; operation: string; applicationErrorCode: string;
  originalNativeErrorCode: string | null; originalExceptionName: string;
  sanitizedOriginalExceptionMessage: string; nestedCauses: SanitizedNotificationException[];
  expoGoHost: boolean | 'unknown'; nativeModule: string | null;
  nativeModuleExists: boolean | null; nativeMethodExists: boolean | null;
  androidOsVersion: { apiLevel: number | null; release: string | null } | null;
};

export function notificationErrorField(error: unknown, key: string): unknown {
  try { return error && typeof error === 'object' && key in error ? (error as Record<string, unknown>)[key] : undefined; }
  catch { return undefined; }
}
export function safeNativeErrorCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : null;
}
function sanitizeMessage(value: unknown, fixedChannel: boolean): string {
  if (typeof value !== 'string' || !value.trim()) return 'Native exception did not provide a message.';
  // Channel calls contain fixed configuration only. Other APIs may carry a
  // notification/financial payload: expose structural exception identity only.
  if (!fixedChannel || /\b(accounts?|salary|borrow|person|payload|private|user details|financial records)\b/i.test(value) || /[{}]/.test(value)) return 'Native message withheld by diagnostic redaction.';
  return value
    .replace(/\b(?:https?|exp|exps|file|content):\/\/[^\s)]+/gi, '[redacted URL]')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[redacted email]')
    .replace(/@[\w.-]+\/[\w./-]+/g, '[redacted scope]')
    .replace(/(?:[A-Za-z]:\\|\/(?:data|storage|sdcard|Users|home)\/)[^\s)]+/g, '[redacted path]')
    .replace(/(["'`])[^"'`\r\n]*\1/g, '[redacted value]')
    .replace(/\b(?:token|password|secret|username|authorization)\s*[:=]\s*\S+/gi, '[redacted credential]')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '[redacted date]').slice(0, 700);
}
export function sanitizedNotificationExceptionChain(error: unknown, fixedChannel: boolean): SanitizedNotificationException[] {
  const original = notificationErrorField(error, 'name') === 'ChannelPreparationError' && notificationErrorField(error, 'cause') != null ? notificationErrorField(error, 'cause') : error;
  const chain: unknown[] = [original];
  for (let i = 0; i < 3; i++) { const cause = notificationErrorField(chain.at(-1), 'cause'); if (cause == null || chain.includes(cause)) break; chain.push(cause); }
  return chain.map(item => {
    const message = typeof item === 'string' ? item : notificationErrorField(item, 'message');
    const nativeName = typeof message === 'string' ? message.match(/\b(?:java|javax|android|expo|com|host)\.[A-Za-z0-9_.$]*(?:Exception|Error)\b/)?.[0] : undefined;
    const stringName = typeof item === 'string' ? item.match(/\b(?:TypeError|ReferenceError|RangeError|SyntaxError|URIError|EvalError|AggregateError|UnavailabilityError|Error)(?=:)/)?.[0] : undefined;
    const name = notificationErrorField(item, 'name');
    return { exceptionName: nativeName ?? stringName ?? (typeof name === 'string' && /^[A-Za-z0-9_.$]{1,180}$/.test(name) ? name : typeof item === 'string' ? 'StringNativeError' : 'UnknownNativeException'),
      safeMessage: sanitizeMessage(message, fixedChannel),
      nativeCode: safeNativeErrorCode(notificationErrorField(item, 'code')) ?? (typeof item === 'string' ? item.match(/\b(?:ERR_|E_)[A-Z0-9_]+\b/)?.[0] ?? null : null) };
  });
}
export function notificationExpoGoHost(): boolean | 'unknown' {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Guarded development-only public host flag; do not read user/project config.
    const api: typeof import('expo') = require('expo');
    return typeof api.isRunningInExpoGo === 'function' ? api.isRunningInExpoGo() : 'unknown';
  } catch { return 'unknown'; }
}
const operations: Record<string, { module: string; method: string }> = {
  channel: { module: 'ExpoNotificationChannelManager', method: 'setNotificationChannelAsync' },
  'permission-query': { module: 'ExpoNotificationPermissionsModule', method: 'getPermissionsAsync' },
  'permission-request': { module: 'ExpoNotificationPermissionsModule', method: 'requestPermissionsAsync' },
  schedule: { module: 'ExpoNotificationScheduler', method: 'scheduleNotificationAsync' },
  enumerate: { module: 'ExpoNotificationScheduler', method: 'getAllScheduledNotificationsAsync' },
  cancel: { module: 'ExpoNotificationScheduler', method: 'cancelScheduledNotificationAsync' },
  response: { module: 'ExpoNotificationsEmitter', method: 'getLastNotificationResponse' },
  presentation: { module: 'ExpoNotificationsHandlerModule', method: 'handleNotificationAsync' },
};
function nativeAvailability(module: string | null, method: string) {
  if (!module) return { nativeModuleExists: null, nativeMethodExists: null };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Read-only optional registry probe at failure time, never invoke notification methods or log registry contents.
    const api: typeof import('expo-modules-core') = require('expo-modules-core');
    const value = api.requireOptionalNativeModule<Record<string, unknown>>(module);
    return { nativeModuleExists: value !== null, nativeMethodExists: value !== null ? typeof value[method] === 'function' : false };
  } catch { return { nativeModuleExists: null, nativeMethodExists: null }; }
}
function androidOsVersion(): NotificationDiagnostic['androidOsVersion'] {
  if (Platform.OS !== 'android') return null;
  try {
    const version = Platform.Version;
    const release = notificationErrorField(Platform.constants, 'Release');
    return { apiLevel: typeof version === 'number' && Number.isSafeInteger(version) ? version : null, release: typeof release === 'string' && /^\d{1,3}(?:\.\d{1,3}){0,3}$/.test(release) ? release : null };
  } catch { return { apiLevel: null, release: null }; }
}
let lastError: NotificationDiagnostic | null = null;
const listeners = new Set<() => void>();
export function getLastNotificationDiagnostic() { return lastError; }
export function captureNotificationDiagnostic(error: unknown, context: { stage: string; applicationErrorCode: string; operation?: string; originalStage?: string }): void {
  if (!__DEV__) return;
  const inheritedOperation = notificationErrorField(notificationErrorField(error, 'diagnostic'), 'operation');
  const source = operations[context.originalStage ?? context.stage];
  const operation = context.operation ?? (typeof inheritedOperation === 'string' && ['setNotificationChannelAsync', 'getNotificationChannelAsync', 'verifyChannel'].includes(inheritedOperation) ? inheritedOperation : source?.method ?? 'unknown');
  const fixedChannel = source?.module === 'ExpoNotificationChannelManager' || ['setNotificationChannelAsync', 'getNotificationChannelAsync', 'verifyChannel'].includes(operation);
  const nativeModule = fixedChannel ? 'ExpoNotificationChannelManager' : source?.module ?? null;
  const chain = sanitizedNotificationExceptionChain(error, fixedChannel);
  lastError = { stage: context.stage, operation, applicationErrorCode: context.applicationErrorCode,
    originalNativeErrorCode: chain[0].nativeCode, originalExceptionName: chain[0].exceptionName,
    sanitizedOriginalExceptionMessage: chain[0].safeMessage, nestedCauses: chain.slice(1),
    expoGoHost: notificationExpoGoHost(), nativeModule, ...nativeAvailability(nativeModule, operation === 'verifyChannel' ? 'getNotificationChannelAsync' : operation), androidOsVersion: androidOsVersion() };
  listeners.forEach(listener => listener());
}
export function clearNotificationDiagnostic() { if (!__DEV__) return; lastError = null; listeners.forEach(listener => listener()); }
export function notificationDiagnosticJson(): string | null { return lastError ? JSON.stringify(lastError, null, 2) : null; }
