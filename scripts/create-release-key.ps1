# One-time: creates YOUR release (upload) key for Walleaf (file and alias keep the old expense-tracker names) and tells the build where it is.
# Run it yourself (it asks for a password; nobody else ever sees it):
#   powershell -ExecutionPolicy Bypass -File .\scripts\create-release-key.ps1
#
# KEEP THE KEY FILE AND PASSWORD SAFE (e.g. a USB drive + a password manager). If you lose either,
# you can never publish an update to the same app on the Play Store.

$keyDir = Join-Path $env:USERPROFILE ".android-keys"
$keyFile = Join-Path $keyDir "expense-tracker-upload.jks"
$alias = "expense-tracker"
$keytool = Join-Path $env:USERPROFILE ".gradle\jdks\eclipse_adoptium-17-amd64-windows.2\bin\keytool.exe"
$gradleProps = Join-Path $env:USERPROFILE ".gradle\gradle.properties"

if (Test-Path $keyFile) { Write-Host "A key already exists at $keyFile. Not overwriting it." -ForegroundColor Yellow; exit 1 }
if (-not (Test-Path $keytool)) { Write-Host "keytool not found at $keytool (JDK 17 is needed)." -ForegroundColor Red; exit 1 }
New-Item -ItemType Directory -Force $keyDir | Out-Null

Write-Host "Creating your release key. keytool will ask for a password (min 6 characters) and your name/organisation." -ForegroundColor Cyan
& $keytool -genkeypair -v -storetype PKCS12 -keystore $keyFile -alias $alias -keyalg RSA -keysize 2048 -validity 10000
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $keyFile)) { Write-Host "Key was not created." -ForegroundColor Red; exit 1 }

# The build needs the password too. It is stored only in your own Gradle settings file on this PC.
$secure = Read-Host -AsSecureString "Type the same key password again so release builds can use it"
$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
$existing = if (Test-Path $gradleProps) { Get-Content $gradleProps | Where-Object { $_ -notmatch '^EXPENSE_TRACKER_UPLOAD_' } } else { @() }
$lines = @($existing) + @(
  "EXPENSE_TRACKER_UPLOAD_STORE_FILE=$($keyFile -replace '\\', '/')",
  "EXPENSE_TRACKER_UPLOAD_STORE_PASSWORD=$plain",
  "EXPENSE_TRACKER_UPLOAD_KEY_ALIAS=$alias",
  "EXPENSE_TRACKER_UPLOAD_KEY_PASSWORD=$plain"
)
Set-Content -Path $gradleProps -Value $lines -Encoding ascii
$plain = $null

Write-Host ""
Write-Host "Done. Release builds are now signed with your key:" -ForegroundColor Green
Write-Host "  Key file: $keyFile"
Write-Host "  Back it up now, together with the password."
