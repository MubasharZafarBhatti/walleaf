import { useEffect } from 'react';
import * as SplashScreen from 'expo-splash-screen';

// The native Walleaf splash stays up while the database opens, so a normal
// start goes splash -> app with no "Loading your finances..." screen between.
// If loading ever takes longer than this, the splash goes away and the
// in-app loading screen takes over, so the app can never look frozen.
export const SPLASH_MAX_WAIT_MS = 8000;

export function holdStartupSplash() {
  void SplashScreen.preventAutoHideAsync().catch(() => {});
}

export function useHideStartupSplash(done: boolean) {
  useEffect(() => {
    const timer = setTimeout(hideStartupSplash, SPLASH_MAX_WAIT_MS);
    return () => clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (done) hideStartupSplash();
  }, [done]);
}

function hideStartupSplash() {
  try {
    SplashScreen.hide();
  } catch {
    // Already hidden, or no native splash (tests, web).
  }
}
