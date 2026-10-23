# Wydania

Pitwall jest dystrybuowany jako archiwa zip w [GitHub Releases](https://github.com/jakubprill/pitwall/releases), bez instalatora. Workflow `.github/workflows/release.yml` buduje je przy wypchnięciu tagu.

## Jak wydać wersję

1. Podbij wersję w trzech miejscach (test `apps/desktop/test/versions.test.ts` pilnuje zgodności):
   `packages/daemon/package.json`, `apps/desktop/src-tauri/tauri.conf.json`, `apps/desktop/src-tauri/Cargo.toml`.
2. Scal zmianę do `main` przez PR.
3. Na `main` utwórz i wypchnij tag z tą samą wersją:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

   Tag z myślnikiem (np. `v0.2.0-rc.1`) tworzy pre-release.

Workflow sprawdza, że tag wskazuje commit z `main` i zgadza się z wersją w `tauri.conf.json`, buduje równolegle na `windows-latest` i `macos-latest` tymi samymi skryptami co CI (`pnpm build:desktop`, smoke test sidecara, `pnpm portable`), a release publikuje dopiero po sukcesie obu buildów. Release zawiera:

| Plik | Zawartość |
|---|---|
| `pitwall-<wersja>-windows-x64.zip` | folder `Pitwall` z `pitwall.exe`, `pitwall-daemon.exe`, `ui/`, `CZYTAJ.txt` |
| `pitwall-<wersja>-macos-arm64.zip` | `Pitwall.app` (Apple Silicon) |
| `SHA256SUMS.txt` | sumy SHA-256 obu archiwów |

Opis release generuje GitHub z listy PR-ów od poprzedniego tagu. Jeśli workflow padnie w kroku publikacji, wystarczy go uruchomić ponownie: istniejący release dostanie podmienione pliki, drugi nie powstanie.

## Instalacja na nowym komputerze

Pobierz archiwum dla swojego systemu i sprawdź sumę z `SHA256SUMS.txt`.

**Windows.** Plik pobrany z internetu ma znacznik „Mark of the Web”, który Windows przenosi na rozpakowane pliki, więc SmartScreen blokuje start. Przed rozpakowaniem odblokuj archiwum:

```powershell
Get-FileHash .\pitwall-0.2.0-windows-x64.zip -Algorithm SHA256
Unblock-File .\pitwall-0.2.0-windows-x64.zip
Expand-Archive .\pitwall-0.2.0-windows-x64.zip "$env:LOCALAPPDATA\Programs"
& "$env:LOCALAPPDATA\Programs\Pitwall\pitwall.exe"
```

Archiwum zawiera folder `Pitwall`, więc aplikacja ląduje w `%LOCALAPPDATA%\Programs\Pitwall`.

Wymagany jest WebView2 (jest w Windows 11 i w większości aktualnych Windows 10). AppLocker może nie pozwolić na uruchamianie z `Downloads`; folder w `%LOCALAPPDATA%\Programs` zwykle jest dozwolony, ale to zależy od polityki firmy.

**macOS.** Aplikacja nie jest jeszcze podpisana ani notaryzowana, więc Gatekeeper po pobraniu przez przeglądarkę zgłasza, że jest „uszkodzona”. Po rozpakowaniu zdejmij kwarantannę:

```sh
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
ditto -x -k pitwall-0.2.0-macos-arm64.zip /Applications
xattr -dr com.apple.quarantine /Applications/Pitwall.app
```

Na obu systemach dane użytkownika (`~/.pitwall`, na Windowsie `%USERPROFILE%\.pitwall`) są poza folderem aplikacji, więc aktualizacja to zamknięcie aplikacji (tray > Wyjdź, żeby zatrzymać też daemona) i podmiana folderu lub `.app` na nowy.

## Czego jeszcze nie ma (kolejne kroki)

- **Auto-update.** Wtyczka updatera Tauri na Windowsie aktualizuje przez instalator NSIS lub MSI, a my celowo budujemy portable bez instalatora. Na macOS działa z archiwum `.app.tar.gz`. Proponowana kolejność:
  1. W aplikacji „sprawdź aktualizacje”: zapytanie o najnowszy release przez API GitHuba i link do pobrania. Mało kodu, działa na obu systemach.
  2. Na macOS włączenie updatera Tauri (`createUpdaterArtifacts`, klucz minisign w sekretach repo, `latest.json` w release).
  3. Na Windowsie własna podmiana: pobranie zip, weryfikacja podpisu minisign, zatrzymanie daemona, zmiana nazwy działającego `pitwall.exe` na `.old` (Windows na to pozwala), rozpakowanie i restart. Alternatywa: dodatkowo publikować instalator NSIS w trybie per-user i użyć standardowego updatera.
- **Podpis kodu.** Azure Trusted Signing dla Windows (mniej ostrzeżeń SmartScreen, łatwiej z AppLockerem) oraz Developer ID i notaryzacja dla macOS. Bez tego obowiązują kroki odblokowania opisane wyżej.
- **macOS Intel.** Teraz tylko Apple Silicon. Build `universal-apple-darwin` wymaga sidecara daemona dla obu architektur (`bun build --compile` dwa razy i `lipo`).
