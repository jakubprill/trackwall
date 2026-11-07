#!/bin/sh
# The Trackwall Dev Container Feature (ADR-164): installs the Linux release archive of one version (ADR-163) and the
# `trackwall-container` command, which the Feature's entrypoint and postStartCommand run. A shell script, because the Dev Containers
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

# The "sandbox" option (ADR-219): the programs Copilot CLI's sandbox runs on in Linux, so that tasks without approvals can
# run their commands in it. They make namespaces only once the container gets the seccomp profile of the dev container
# guide; the daemon checks that at every start and keeps the sandbox off by default until then.
SANDBOX="${SANDBOX:-false}"
case "$SANDBOX" in
true | false) ;;
*) fail "sandbox must be true or false, got '$SANDBOX'" ;;
esac
if [ "$SANDBOX" = true ]; then
  if command -v apt-get > /dev/null 2>&1; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends bubblewrap slirp4netns iproute2 iptables util-linux > /dev/null
    rm -rf /var/lib/apt/lists/*
  elif command -v apk > /dev/null 2>&1; then
    apk add --no-cache -q bubblewrap slirp4netns iproute2 iptables util-linux
  elif command -v dnf > /dev/null 2>&1; then
    dnf install -y -q bubblewrap slirp4netns iproute iptables-nft util-linux
  else
    fail "the sandbox option needs apt-get, apk or dnf; install bubblewrap, slirp4netns, iproute2 and iptables in the image instead"
  fi
fi

# The user VS Code works as; Trackwall runs as that user, with its state in that user's home.
USER_NAME="${_REMOTE_USER:-root}"
case "$USER_NAME" in
'' | -* | *[!A-Za-z0-9._-]*) fail "unexpected remote user name '$USER_NAME'" ;;
esac
id "$USER_NAME" > /dev/null 2>&1 || fail "no user '$USER_NAME' in the image"
USER_UID="$(id -u "$USER_NAME")"
USER_GID="$(id -g "$USER_NAME")"
USER_HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)"
case "$USER_HOME" in
/* ) ;;
*) fail "no home folder for '$USER_NAME'" ;;
esac
case "$USER_HOME" in
*[!A-Za-z0-9._/-]*) fail "unexpected home folder '$USER_HOME'" ;;
esac
# How the command switches from root to that user: setpriv, else runuser, by absolute path (both from util-linux, which
# some releases split into several packages).
if [ -x /usr/bin/setpriv ]; then
  AS_USER="/usr/bin/setpriv --reuid=$USER_UID --regid=$USER_GID --init-groups --"
elif [ -x /usr/sbin/runuser ]; then
  AS_USER="/usr/sbin/runuser -u $USER_NAME --"
elif [ "$USER_UID" != 0 ]; then
  fail "neither setpriv nor runuser is in the image (apt-get install util-linux)"
fi

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
  curl -fsSL --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$TMP/$ARCHIVE" "$RELEASE_URL/$ARCHIVE"
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
# daemon.json are where the desktop app looks for them; TRACKWALL_HOME from containerEnv is kept. As root it trusts
# nothing from the caller's PATH, which may hold folders the remote user can write. Tools installed with mise (Copilot
# CLI, mise itself) are found without a login shell, which neither docker exec nor postStartCommand has.
cat > /usr/local/bin/trackwall-container << WRAPPER
#!/bin/sh
# Trackwall $VERSION in this dev container, written by the Trackwall Dev Container Feature.
set -eu
if [ "\$(/usr/bin/id -u)" = 0 ] && [ $USER_UID != 0 ]; then
  HOME='$USER_HOME' exec ${AS_USER:-} /usr/local/bin/trackwall-container "\$@"
fi
PATH="\${MISE_DATA_DIR:-\$HOME/.local/share/mise}/shims:\$HOME/.local/bin:\$PATH"
export PATH
# The version trackwall-container update made current (ADR-165), when bin/current names a release version such as
# 1.2.3 whose binary is there; otherwise the Feature's own. Only this user's processes write bin/, and root never gets
# here. The state directory is TRACKWALL_HOME's or the default; a --home on the command line does not move bin/.
bin='$DEST/trackwall-daemon'
bin_dir="\${TRACKWALL_HOME:-\$HOME/.trackwall}/bin"
current=\$(cat "\$bin_dir/current" 2>/dev/null || true)
case "\$current" in
*[!0-9A-Za-z.-]* | *..* | *.-* | -*) ;;
[0-9]*.[0-9]*.[0-9]*) if [ -x "\$bin_dir/\$current/trackwall-daemon" ]; then bin="\$bin_dir/\$current/trackwall-daemon"; fi ;;
*) ;;
esac
# start and update on the Feature's port, which a --port of the caller's overrides; anything else, such as address, as it is.
case "\${1:-}" in
start | update)
  action=\$1
  shift
  exec "\$bin" container "\$action" --port $PORT "\$@"
  ;;
'') exec "\$bin" --help ;;
*) exec "\$bin" "\$@" ;;
esac
WRAPPER
chmod 755 /usr/local/bin/trackwall-container

# The Feature's entrypoint (ADR-184): every start of the container starts Trackwall, also `docker restart` and a start from
# Docker or Rancher Desktop, which run no postStartCommand (only the Dev Containers tooling does). In the background,
# so the container's own command is not held up; the start is idempotent, so postStartCommand running it again is a no-op.
# Its JSON goes nowhere, since nobody reads it here; the daemon's own log is logs/daemon.log.
mkdir -p /usr/local/share/trackwall
cat > /usr/local/share/trackwall/entrypoint.sh << 'ENTRYPOINT'
#!/bin/sh
# Starts Trackwall with the container, written by the Trackwall Dev Container Feature.
/usr/local/bin/trackwall-container start > /dev/null &
exec "$@"
ENTRYPOINT
chmod 755 /usr/local/share/trackwall/entrypoint.sh
echo "Trackwall $VERSION installed for $USER_NAME on port $PORT"
