---
title: Install
description: Download Trackwall for Windows or macOS, check it and start it for the first time.
---

# Install

Download Trackwall for Windows or macOS, check it and start it for the first time.

Trackwall runs on Windows (x64) and macOS (Apple Silicon). Each version on the [Releases](https://github.com/jakubprill/trackwall/releases) page has a zip archive per system and a `SHA256SUMS.txt` with their checksums; there is no installer. The builds are not signed yet, so Windows SmartScreen and macOS Gatekeeper block an archive downloaded with a browser. The steps below avoid that.

## Windows

A browser marks a downloaded file as coming from the internet, and SmartScreen then blocks `trackwall.exe`, often without a "Run anyway" button. Command-line tools do not add that mark. In PowerShell, with the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`), this downloads the version in `$v`, checks its sum and unpacks it to `%LOCALAPPDATA%\Programs\Trackwall`:

```powershell
$v = "0.5.6"
$zip = "trackwall-$v-windows-x64.zip"
gh release download "v$v" -R jakubprill/trackwall -p $zip -p SHA256SUMS.txt -D $env:TEMP --clobber
if ($LASTEXITCODE) { throw "gh release download failed" }
$sum = ((Select-String -Path "$env:TEMP\SHA256SUMS.txt" -Pattern $zip -SimpleMatch).Line -split '\s+')[0]
if (-not $sum -or (Get-FileHash "$env:TEMP\$zip" -Algorithm SHA256).Hash -ne $sum) { throw "wrong or missing SHA-256 sum for $zip" }
if (Test-Path "$env:LOCALAPPDATA\Programs\Trackwall") { Remove-Item "$env:LOCALAPPDATA\Programs\Trackwall" -Recurse -Force }
Expand-Archive "$env:TEMP\$zip" "$env:LOCALAPPDATA\Programs"
& "$env:LOCALAPPDATA\Programs\Trackwall\trackwall.exe"
```

The old folder is removed only after a successful download and a matching sum, and as a whole: unpacking over it would keep files of the previous version.

Trackwall needs WebView2, which comes with Windows 11 and most up-to-date Windows 10 installations.

### Without the GitHub CLI

The `curl.exe` built into Windows 10 (since 1803) and 11 downloads without the mark too. Use it in place of the `gh release download` line, once for the archive and once for `SHA256SUMS.txt`:

```powershell
curl.exe -fL -o "$env:TEMP\$zip" "https://github.com/jakubprill/trackwall/releases/download/v$v/$zip"
```

- Type `curl.exe`: in Windows PowerShell 5.1, `curl` means `Invoke-WebRequest`.
- `-f` ends the command on an HTTP error instead of saving the error page as the zip.
- Behind a proxy, neither `gh` nor `curl.exe` reads the system proxy settings. Set `HTTPS_PROXY`, or give `curl.exe` the proxy with `-x http://<proxy>:<port>`; for a proxy that signs you in with your Windows account, add `--proxy-negotiate -U :` (`gh` cannot use such a proxy). When a proxy that replaces certificates makes `curl.exe` fail with `CRYPT_E_NO_REVOCATION_CHECK`, add `--ssl-no-revoke`.
- An archive you already downloaded with a browser works after `Unblock-File <file.zip>`, run before unpacking it.

## macOS

Gatekeeper reports an unsigned app downloaded with a browser as "damaged". Download the macOS zip and `SHA256SUMS.txt` from [Releases](https://github.com/jakubprill/trackwall/releases) into one folder, then run these commands there to check the archive, unpack it and remove the quarantine mark:

```sh
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
ditto -x -k trackwall-0.5.6-macos-arm64.zip /Applications
xattr -dr com.apple.quarantine /Applications/Trackwall.app
```

## Update

Trackwall offers new versions itself: see [App updates](/features/updates).

To update by hand, for example when a proxy stops the download or on 0.4.0, which cannot update itself: your data lives in `~/.trackwall` (on Windows `%USERPROFILE%\.trackwall`), outside the app folder. Quit Trackwall from the tray ("Quit", which also stops what runs in the background, so its files can be replaced) and install the new version the same way.

## First start

Set the projects folder in "Settings", then [connect Copilot CLI](/guide/connect-copilot-cli). The [list of all features](/features/) shows what to try next.
