#!/bin/sh
# The Trackwall Dev Container Feature (ADR-164): installs the Linux release archive of one version (ADR-163) and the
# `trackwall-container` command, which the Feature's postStartCommand runs. A shell script, because the Dev Containers
# specification runs a Feature's install.sh while the image is built, as root, before anything else is there.
#
# The release workflow fills in the values in @...@ (apps/desktop/scripts/package-feature.ts). The archive is checked
# against the SHA-256 written into this file at release, so it is exactly the archive released with this Feature.
set -eu

VERSION='@VERSION@'
RELEASE_URL='@RELEASE_URL@'
SHA256_X64='@SHA256_X64@'
SHA256_ARM64='@SHA256_ARM64@'

fail() {
  echo "trackwall feature: $*" >&2
  exit 1
}

PORT="${PORT:-7700}"
case "$PORT" in
'' | *[!0-9]*) fail "port must be a number, got '$PORT'" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "port out of range 1-65535: $PORT"

# The user VS Code works as; Trackwall runs as that user, with its state in that user's home.
USER_NAME="${_REMOTE_USER:-root}"
case "$USER_NAME" in
'' | -* | *[!A-Za-z0-9._-]*) fail "unexpected remote user name '$USER_NAME'" ;;
esac
id "$USER_NAME" > /dev/null 2>&1 || fail "no user '$USER_NAME' in the image"

case "$(uname -m)" in
x86_64 | amd64) ARCH=x64 SHA256="$SHA256_X64" ;;
aarch64 | arm64) ARCH=arm64 SHA256="$SHA256_ARM64" ;;
*) fail "no Trackwall archive for $(uname -m); there are x86_64 and aarch64" ;;
esac
[ -n "$SHA256" ] || fail "this Feature was packed without the $ARCH archive"
for tool in tar sha256sum; do
  command -v "$tool" > /dev/null 2>&1 || fail "$tool is missing in the image"
done

ARCHIVE="trackwall-$VERSION-linux-$ARCH.tar.gz"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
# TRACKWALL_FEATURE_ARCHIVE: a local copy of the archive, for CI; it is checked against the same SHA-256.
if [ -n "${TRACKWALL_FEATURE_ARCHIVE:-}" ]; then
  cp "$TRACKWALL_FEATURE_ARCHIVE" "$TMP/$ARCHIVE"
elif command -v curl > /dev/null 2>&1; then
  curl -fsSL --proto '=https' --tlsv1.2 -o "$TMP/$ARCHIVE" "$RELEASE_URL/$ARCHIVE"
elif command -v wget > /dev/null 2>&1; then
  wget -q --https-only -O "$TMP/$ARCHIVE" "$RELEASE_URL/$ARCHIVE"
else
  fail "curl or wget is needed to download $ARCHIVE"
fi
echo "$SHA256  $TMP/$ARCHIVE" | sha256sum -c - > /dev/null || fail "$ARCHIVE does not match the SHA-256 of this Feature"

DEST="/usr/local/lib/trackwall/$VERSION"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$TMP/$ARCHIVE" -C "$DEST" --strip-components=1 --no-same-owner --no-same-permissions
chmod -R u=rwX,go=rX "$DEST"
chmod 755 "$DEST/trackwall-daemon"

# Run as root (docker exec without --user), the command runs itself again as the remote user, so the daemon's state and
# daemon.json are where the desktop app looks for them; TRACKWALL_HOME from containerEnv is kept. Tools installed with
# mise (Copilot CLI, mise itself) are found without a login shell, which neither docker exec nor postStartCommand has.
cat > /usr/local/bin/trackwall-container << WRAPPER
#!/bin/sh
# Trackwall $VERSION in this dev container, written by the Trackwall Dev Container Feature.
set -eu
if [ "\$(id -u)" = 0 ] && [ '$USER_NAME' != root ]; then
  exec su -s /bin/sh -c 'exec /usr/local/bin/trackwall-container "\$@"' -- '$USER_NAME' trackwall-container "\$@"
fi
PATH="\${MISE_DATA_DIR:-\$HOME/.local/share/mise}/shims:\$HOME/.local/bin:\$PATH"
export PATH
# start (and the container's other subcommands) on the Feature's port; anything else, such as address, as it is.
case "\${1:-}" in
start) exec '$DEST/trackwall-daemon' container "\$@" --port $PORT ;;
*) exec '$DEST/trackwall-daemon' "\$@" ;;
esac
WRAPPER
chmod 755 /usr/local/bin/trackwall-container
echo "Trackwall $VERSION installed for $USER_NAME on port $PORT"
