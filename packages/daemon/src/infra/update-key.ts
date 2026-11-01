/**
 * The public key every Trackwall release is signed with (`plugins.updater.pubkey` in `tauri.conf.json`, ADR-53; a test
 * keeps the two equal). Compiled into the daemon, so `trackwall-container update` checks a new version with the key of the
 * version already installed, never with one that comes with the download (ADR-165).
 */
export const UPDATE_PUBLIC_KEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDNGQTJGOENCOUI0RkMyNjIKUldSaXdrK2J5L2lpUDB0YzlVUnRKaTQxdk5jeHZUb0ZPM2tKSEFZVkc1V0dkUXM4Z0lWcEpYYlgK";
