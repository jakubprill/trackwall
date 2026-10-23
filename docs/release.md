# Wydania

Trackwall jest dystrybuowany jako archiwa zip w [GitHub Releases](https://github.com/jakubprill/trackwall/releases), bez instalatora. Workflow `.github/workflows/release.yml` buduje je przy wypchnięciu tagu.

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
| `trackwall-<wersja>-windows-x64.zip` | folder `Trackwall` z `trackwall.exe`, `trackwall-daemon.exe`, `ui/`, `CZYTAJ.txt` |
| `trackwall-<wersja>-macos-arm64.zip` | `Trackwall.app` (Apple Silicon) |
| `SHA256SUMS.txt` | sumy SHA-256 obu archiwów |

Opis release generuje GitHub z listy PR-ów od poprzedniego tagu. Jeśli workflow padnie w kroku publikacji, wystarczy go uruchomić ponownie: istniejący release dostanie podmienione pliki, drugi nie powstanie.

## Instalacja na nowym komputerze

Pobierz archiwum dla swojego systemu i sprawdź sumę z `SHA256SUMS.txt`.

**Windows.** Przeglądarka dokleja do pobranego pliku znacznik „Mark of the Web”, więc SmartScreen blokuje start `trackwall.exe` (często bez przycisku „Uruchom mimo to”). Narzędzia z terminala tego znacznika nie dodają, dlatego najprościej pobrać archiwum przez `gh` (repo jest prywatne, więc potrzebny jest zalogowany `gh auth login`) i sprawdzić sumę:

```powershell
$v = "0.2.0"
$zip = "trackwall-$v-windows-x64.zip"
gh release download "v$v" -R jakubprill/trackwall -p $zip -p SHA256SUMS.txt -D $env:TEMP --clobber
if ($LASTEXITCODE) { throw "gh release download nie powiodło się" }
$sum = ((Select-String -Path "$env:TEMP\SHA256SUMS.txt" -Pattern $zip -SimpleMatch).Line -split '\s+')[0]
if (-not $sum -or (Get-FileHash "$env:TEMP\$zip" -Algorithm SHA256).Hash -ne $sum) { throw "zła albo brakująca suma SHA-256 dla $zip" }
if (Test-Path "$env:LOCALAPPDATA\Programs\Trackwall") { Remove-Item "$env:LOCALAPPDATA\Programs\Trackwall" -Recurse -Force }
Expand-Archive "$env:TEMP\$zip" "$env:LOCALAPPDATA\Programs"
& "$env:LOCALAPPDATA\Programs\Trackwall\trackwall.exe"
```

Stary folder znika dopiero po udanym pobraniu i zgodnej sumie. Przed aktualizacją zamknij Trackwall (tray > Wyjdź), bo `Remove-Item` nie usunie plików działającej aplikacji. Plik pobrany przeglądarką odblokuj przed rozpakowaniem: `Unblock-File <plik.zip>`. Folder usuwamy w całości, a nie rozpakowujemy na stary: zostałyby pliki poprzedniej wersji, a w folderze rozpakowanym wcześniej z pliku ze znacznikiem także sam znacznik.

Bez `gh`, gdy repo będzie publiczne, archiwum pobierze wbudowany w Windows 10 (od 1803) i 11 `curl.exe`, też bez znacznika: `curl.exe -fL -o "$env:TEMP\$zip" "https://github.com/jakubprill/trackwall/releases/download/v$v/$zip"` (i tak samo `SHA256SUMS.txt`). Pisz `curl.exe`, bo w Windows PowerShell 5.1 `curl` to alias `Invoke-WebRequest`; `-f` sprawia, że błąd HTTP kończy komendę, zamiast zapisać stronę błędu jako zip. Ani `gh`, ani `curl.exe` nie biorą proxy z ustawień systemu; dla `gh` ustaw `HTTPS_PROXY` (proxy z logowaniem Windows nie jest przez `gh` obsługiwane). Dla `curl.exe`: podaj proxy w `HTTPS_PROXY` albo `-x http://<proxy>:<port>` (proxy z logowaniem Windows: dodatkowo `--proxy-negotiate -U :`), a gdy proxy podmienia certyfikaty i pojawia się `CRYPT_E_NO_REVOCATION_CHECK`, dodaj `--ssl-no-revoke`.

Archiwum zawiera folder `Trackwall`, więc aplikacja ląduje w `%LOCALAPPDATA%\Programs\Trackwall`.

Wymagany jest WebView2 (jest w Windows 11 i w większości aktualnych Windows 10).

**macOS.** Aplikacja nie jest jeszcze podpisana ani notaryzowana, więc Gatekeeper po pobraniu przez przeglądarkę zgłasza, że jest „uszkodzona”. Po rozpakowaniu zdejmij kwarantannę:

```sh
shasum -a 256 -c SHA256SUMS.txt --ignore-missing
ditto -x -k trackwall-0.2.0-macos-arm64.zip /Applications
xattr -dr com.apple.quarantine /Applications/Trackwall.app
```

Przejście z 0.1.0 (wydanej jeszcze pod nazwą Pitwall, ADR-11): nowa wersja nie wykrywa starej, bo ma inny katalog stanu i identyfikator aplikacji. Przed pierwszym uruchomieniem zamknij Pitwall z traya (Wyjdź), usuń `%LOCALAPPDATA%\Programs\Pitwall` (macOS: `Pitwall.app` z Aplikacji) i, jeśli chcesz, `~/.pitwall`. Nic stamtąd nie jest potrzebne.

Na obu systemach dane użytkownika (`~/.trackwall`, na Windowsie `%USERPROFILE%\.trackwall`) są poza folderem aplikacji, więc aktualizacja to zamknięcie aplikacji (tray > Wyjdź, żeby zatrzymać też daemona) i podmiana folderu lub `.app` na nowy.

## Przed upublicznieniem repo

Jednorazowo, robi to właściciel w ustawieniach repo (Settings > Security): włączyć prywatne zgłoszenia podatności (na nie wskazuje `SECURITY.md`), alerty Dependabot i secret scanning z push protection. Dopiero potem zmienić widoczność na publiczną.

## Czego jeszcze nie ma (kolejne kroki)

- **Auto-update.** Wtyczka updatera Tauri na Windowsie aktualizuje przez instalator NSIS lub MSI, a my celowo budujemy portable bez instalatora. Na macOS działa z archiwum `.app.tar.gz`. Proponowana kolejność:
  1. W aplikacji „sprawdź aktualizacje”: zapytanie o najnowszy release przez API GitHuba i link do pobrania. Mało kodu, działa na obu systemach.
  2. Na macOS włączenie updatera Tauri (`createUpdaterArtifacts`, klucz minisign w sekretach repo, `latest.json` w release).
  3. Na Windowsie własna podmiana: pobranie zip, weryfikacja podpisu minisign, zatrzymanie daemona, zmiana nazwy działającego `trackwall.exe` na `.old` (Windows na to pozwala), rozpakowanie i restart. Alternatywa: dodatkowo publikować instalator NSIS w trybie per-user i użyć standardowego updatera.
- **Podpis kodu.** Azure Trusted Signing dla Windows (mniej ostrzeżeń SmartScreen) oraz Developer ID i notaryzacja dla macOS. Bez tego obowiązują kroki odblokowania opisane wyżej.
- **macOS Intel.** Teraz tylko Apple Silicon. Build `universal-apple-darwin` wymaga sidecara daemona dla obu architektur (`bun build --compile` dwa razy i `lipo`).
