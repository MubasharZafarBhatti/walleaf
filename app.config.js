// Native identity changes only for the explicitly selected development variant.
// Expo Go/unset and production keep the app.json identity ("Walleaf", com.mubashar.expensetracker; the package id predates the name and must never change).
module.exports = ({ config }) => {
  const development = process.env.EXPO_PUBLIC_BUILD_VARIANT === 'development';
  if (!development) return config;
  return {
    ...config,
    name: 'Walleaf Dev',
    scheme: 'expense-tracker-dev',
    android: {
      ...config.android,
      package: `${config.android.package}.dev`,
    },
    plugins: [
      ...(config.plugins ?? []),
      ['expo-dev-client', { launchMode: 'most-recent', addGeneratedScheme: false }],
    ],
  };
};
