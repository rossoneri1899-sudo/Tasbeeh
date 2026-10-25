# Promote the tested beta to the live app: copies beta/ files to the site root.
# The manifests stay separate (the beta installs as "Tasbeeh β"). Commit and push afterwards.
$repo = Split-Path -Parent $PSScriptRoot
foreach ($f in 'index.html', 'app.js', 'voice.js', 'adhkar.js', 'sw.js', 'icon-180.png', 'icon-192.png', 'icon-512.png') {
    Copy-Item (Join-Path $repo "beta\$f") (Join-Path $repo $f) -Force
}
Write-Output "Copied beta to the live app. Version: $((Select-String -Path (Join-Path $repo 'app.js') -Pattern "APP_VERSION = '([^']+)'").Matches[0].Groups[1].Value)"
