// Signs release builds with your own upload key when it is configured.
//
// The key and its passwords never live in this project: they are read from
// Gradle properties, normally %USERPROFILE%\.gradle\gradle.properties, which
// scripts/create-release-key.ps1 fills in. Without them, release builds fall
// back to the debug key (fine for testing, not accepted by the Play Store).
const { withAppBuildGradle } = require('expo/config-plugins');

const MARK = '// expense-tracker: release signing';
const PREFIX = 'EXPENSE_TRACKER_UPLOAD';

function addReleaseSigning(gradle) {
  if (gradle.includes(MARK)) return gradle;
  const withConfig = gradle.replace(/signingConfigs \{\n(\s*)debug \{/, (match, indent) => [
    'signingConfigs {',
    `${indent}${MARK}`,
    `${indent}release {`,
    `${indent}    if (findProperty('${PREFIX}_STORE_FILE')) {`,
    `${indent}        storeFile file(findProperty('${PREFIX}_STORE_FILE'))`,
    `${indent}        storePassword findProperty('${PREFIX}_STORE_PASSWORD')`,
    `${indent}        keyAlias findProperty('${PREFIX}_KEY_ALIAS')`,
    `${indent}        keyPassword findProperty('${PREFIX}_KEY_PASSWORD')`,
    `${indent}    }`,
    `${indent}}`,
    `${indent}debug {`,
  ].join('\n'));
  const withRelease = withConfig.replace(
    /(release \{\n(?:\s*\/\/[^\n]*\n)*\s*)signingConfig signingConfigs\.debug/,
    `$1signingConfig findProperty('${PREFIX}_STORE_FILE') ? signingConfigs.release : signingConfigs.debug`,
  );
  if (withConfig === gradle || withRelease === withConfig) {
    throw new Error('withReleaseSigning: android/app/build.gradle layout changed; update the plugin.');
  }
  return withRelease;
}

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = addReleaseSigning(mod.modResults.contents);
    return mod;
  });
};
module.exports.addReleaseSigning = addReleaseSigning;
