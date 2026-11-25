# Builds Walleaf and pushes the APK to the phone's Downloads (USB or wireless debugging),
# then shows a Windows notification with the result.
#
#   powershell -ExecutionPolicy Bypass -File .\scripts\build-and-push.ps1
#
# Default: the shareable production app "Walleaf" (com.mubashar.expensetracker), 32-bit + 64-bit ARM
# so Android 7+ budget phones can install it, saved on the phone as Downloads\Walleaf.apk.
#   -Dev          build the side-by-side test app "Walleaf Dev" instead (Downloads\WalleafDev.apk)
#   -Bundle       build the Play Store bundle (.aab) instead of an APK; it is not pushed to the phone
#   -Prebuild     force `expo prebuild` (it already runs by itself when switching between production and -Dev)
#   -StopDaemons  only if a build misbehaves (forces a fresh Gradle daemon, ~20 s slower)
# Release builds are signed with your own key once scripts\create-release-key.ps1 has been run;
# until then they use the debug key (fine for testing, not accepted by the Play Store).
param([switch]$Dev, [switch]$Bundle, [switch]$Prebuild, [switch]$StopDaemons)

$root = Split-Path -Parent $PSScriptRoot
$adb = "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe"
$variant = if ($Dev) { "development" } else { "production" }
$appId = if ($Dev) { "com.mubashar.expensetracker.dev" } else { "com.mubashar.expensetracker" }
$phoneFile = if ($Dev) { "/sdcard/Download/WalleafDev.apk" } else { "/sdcard/Download/Walleaf.apk" }

function Notify([string]$title, [string]$text, [bool]$ok) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $n = New-Object System.Windows.Forms.NotifyIcon
  $n.Icon = if ($ok) { [System.Drawing.SystemIcons]::Information } else { [System.Drawing.SystemIcons]::Error }
  $n.Visible = $true
  $n.ShowBalloonTip(15000, $title, $text, $(if ($ok) { 'Info' } else { 'Error' }))
  if ($ok) { [console]::beep(880, 300); [console]::beep(1175, 300) } else { [console]::beep(300, 700) }
  Start-Sleep -Seconds 15
  $n.Dispose()
}

Set-Location $root
$env:EXPO_PUBLIC_BUILD_VARIANT = $variant
$env:NODE_ENV = "production"
$env:JAVA_HOME = "$env:USERPROFILE\.gradle\jdks\eclipse_adoptium-17-amd64-windows.2"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:Path = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:Path"

# The android folder is generated for one identity at a time; regenerate it when switching.
$gradleFile = "$root\android\app\build.gradle"
$currentId = if (Test-Path $gradleFile) { (Select-String -Path $gradleFile -Pattern "applicationId '([^']+)'").Matches.Groups[1].Value } else { "" }
if ($Prebuild -or $currentId -ne $appId) {
  Write-Host "Preparing the $variant app ($appId)..." -ForegroundColor Cyan
  & npx expo prebuild --platform android --no-install
  if ($LASTEXITCODE -ne 0) { Notify "Walleaf" "Prebuild FAILED. See the PowerShell window." $false; exit 1 }
}

$gradleProps = Join-Path $env:USERPROFILE ".gradle\gradle.properties"
if (-not ((Test-Path $gradleProps) -and (Select-String -Path $gradleProps -Pattern "^EXPENSE_TRACKER_UPLOAD_STORE_FILE=" -Quiet))) {
  Write-Host "Note: no release key set up yet, so this build uses the debug key. Run scripts\create-release-key.ps1 once." -ForegroundColor Yellow
}

# Reusing the warm JDK 17 daemon saves ~20 s; a daemon on another Java is never reused.
if ($StopDaemons) { & "$root\android\gradlew.bat" -p "$root\android" --stop }
$task = if ($Bundle) { ":app:bundleRelease" } else { ":app:assembleRelease" }
& "$root\android\gradlew.bat" -p "$root\android" $task "-PreactNativeArchitectures=armeabi-v7a,arm64-v8a"
if ($LASTEXITCODE -ne 0) { Notify "Walleaf" "Build FAILED. See the PowerShell window." $false; exit 1 }

if ($Bundle) {
  $aab = "$root\android\app\build\outputs\bundle\release\app-release.aab"
  Write-Host "Play Store bundle: $aab" -ForegroundColor Green
  Notify "Walleaf" "Play Store bundle ready: android\app\build\outputs\bundle\release\app-release.aab" $true
  exit 0
}

$apk = "$root\android\app\build\outputs\apk\release\app-release.apk"
# Wireless port changes, so pick whichever phone is connected right now; prefer the USB cable (much faster).
# Emulators (emulator-5554, ...) are never the target; this pushes the ARM phone build.
$lines = @(& $adb devices | Select-String "\tdevice$" | Where-Object { $_.Line -notmatch "^emulator-" })
$line = @($lines | Where-Object { $_.Line -notmatch "^[^\t]*(:|_adb-tls)" }) + $lines | Select-Object -First 1
if (-not $line) { Notify "Walleaf" "Build OK, but no phone connected. Reconnect wireless debugging and push again." $false; exit 1 }
$device = $line.Line.Split("`t")[0]
# Skip the slow Wi-Fi push when the phone already has this exact APK.
$localHash = (Get-FileHash $apk -Algorithm MD5).Hash.ToLower()
$remoteHash = ((& $adb -s $device shell md5sum $phoneFile 2>$null) -split "\s+")[0]
if ($remoteHash -eq $localHash) { Notify "Walleaf" "No change: the phone already has this APK." $true; exit 0 }
& $adb -s $device push $apk $phoneFile
if ($LASTEXITCODE -ne 0) { Notify "Walleaf" "Build OK, push FAILED. See the PowerShell window." $false; exit 1 }

Notify "Walleaf" "APK ready on the phone: Downloads > $(Split-Path $phoneFile -Leaf) > Install/Update" $true
