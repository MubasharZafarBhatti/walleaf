import { registerRootComponent } from 'expo';

import App from './App';
import { registerReminderActionTask } from './src/services/notifications/ReminderTask';

// Notification buttons pressed while the app is closed start a headless JS run,
// so the reminder action task must be defined before the root component.
registerReminderActionTask();

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
