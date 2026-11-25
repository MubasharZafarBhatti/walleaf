import { createContext } from 'react';
// True only after navigation/data/onboarding and any startup tap are resolved.
export const ReminderNavigationReady = createContext(false);
