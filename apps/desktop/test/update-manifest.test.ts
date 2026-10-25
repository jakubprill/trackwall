import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD_ENTRIES, TAURI_DIR } from "../scripts/lib.ts";
import { keyId, updateManifest } from "../scripts/update-manifest.ts";

// A throwaway key pair made for this test with `tauri signer generate`; its private key is not kept anywhere.
const PUBKEY =
  "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDAyNDcxMEYxMENEMDI0NEUKUldST0pOQU04UkJIQWczeVB3d0RELzZiU21JQ3ptNW1uWTNtL3BYYUFybmxYRUEraWtDamd5TE8K";
// `tauri signer sign --app-version 0.3.1` of the two update packages with that key, and of another file with another key.
const WINDOWS_SIG =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVST0pOQU04UkJIQW1wditmQmJRcUU0elBOaHpudTNPYTdmV2JqNllXSmFxMENBR2VGa2wyRklYYUMybE5aQlA3cWpxamdNcG95NktHdE1Sc3VlSDQxalJsd0VqYXNwK1FJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyODgzODExCWZpbGU6dHJhY2t3YWxsLTAuMy4xLXdpbmRvd3MteDY0LnppcAl2ZXJzaW9uOjAuMy4xCjM4bzVlUHpRNzk3cVRsWExUbEpRYS9JblRQSE9hcmFmTU40MXh3c2djNC9sQkY0UlU3RDBNQm5SQVArUWEyRGkxd2g3bTh0QWl4cUp3b1M4ZTE3bUFnPT0K";
const MACOS_SIG =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVST0pOQU04UkJIQWtkbUNhTmh1NVFHOW0wSnl0dC9nSVoxQWhpN3FuT0ZLMlFEZm50TmtKSGhlRDVGRDFkMnczMWthRU96UVV5NUo1d05rc1NIMjZySXZRdU5IK1BwL0FJPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyODgzODExCWZpbGU6dHJhY2t3YWxsLTAuMy4xLW1hY29zLWFybTY0LmFwcC50YXIuZ3oJdmVyc2lvbjowLjMuMQpReDQzakxJeEtHdWsvamtuYW4waUx6YW1FNG5YY2k0a05HaitERlJwTXlHTW92TWhQbmtobWxuWXZvR2JLNFJNRVhvN2ZYRS9aaEdpVmJnL0FQcU5CZz09Cg==";
const OTHER_KEY_SIG =
  "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVSUTgwZGREOXVja0ZiOWt1bGViWWZKa1ZNSXlJRGsyTFVxMk50SzNWMCs2RzRNUzNTNEV1bTU5azJSRnZTS3poQlpMZ1cwSkZ4Z2g4NjUyM2lHNUVaZ1J0c3lZNkpLQmdRPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkyODg1NzM1CWZpbGU6b3RoZXIudHh0CXZlcnNpb246MC4zLjEKRnFOdmdqRjliTkxtb0ptcDNsMVVHNThOWDMxalB2ajh4ZzVIMWxNMktadXFmQmowLzliQWtTRG1JRGUzUFg5N1JLTU9STkVya2xxYXg4Ums5K1FKRHc9PQo=";

describe("update manifest", () => {
  test("lists the update package of each system under the updater's target name with its address and signature", () => {
    const manifest = updateManifest({
      tag: "v0.3.1",
      repo: "owner/trackwall",
      pubkey: PUBKEY,
      signatures: { "windows-x86_64": `${WINDOWS_SIG}\n`, "darwin-aarch64": MACOS_SIG },
      date: new Date("2026-10-25T10:00:00Z"),
    });
    expect(manifest).toEqual({
      version: "0.3.1",
      pub_date: "2026-10-25T10:00:00.000Z",
      platforms: {
        "windows-x86_64": {
          url: "https://github.com/owner/trackwall/releases/download/v0.3.1/trackwall-0.3.1-windows-x64.zip",
          signature: WINDOWS_SIG,
        },
        "darwin-aarch64": {
          url: "https://github.com/owner/trackwall/releases/download/v0.3.1/trackwall-0.3.1-macos-arm64.app.tar.gz",
          signature: MACOS_SIG,
        },
      },
    });
  });

  test("refuses a package signed with another key than the one installed copies trust", () => {
    expect(() =>
      updateManifest({
        tag: "v0.3.1",
        repo: "owner/trackwall",
        pubkey: PUBKEY,
        signatures: { "windows-x86_64": WINDOWS_SIG, "darwin-aarch64": OTHER_KEY_SIG },
        date: new Date(),
      }),
    ).toThrow(
      `trackwall-0.3.1-macos-arm64.app.tar.gz is signed with key ${keyId(OTHER_KEY_SIG, "")}, but tauri.conf.json has key ${keyId(PUBKEY, "")}`,
    );
  });

  test("the key id of a public key and of a signature made with it are the same", () => {
    expect(keyId(PUBKEY, "public key")).toBe(keyId(WINDOWS_SIG, "signature"));
    expect(keyId(OTHER_KEY_SIG, "signature")).not.toBe(keyId(PUBKEY, "public key"));
  });

  test("refuses text that is not a minisign key or signature", () => {
    expect(() => keyId(Buffer.from("not minisign").toString("base64"), "public key")).toThrow("the public key is not in minisign format");
  });
});

test("the shell's Windows update moves out every entry the portable build ships", () => {
  const source = readFileSync(join(TAURI_DIR, "src", "portable_update.rs"), "utf8");
  const shell = /const BUILD_ENTRIES: \[&str; \d+\] = \[([^\]]*)\];/.exec(source)?.[1] ?? "";
  const names = [...shell.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  expect(names).toEqual(expect.arrayContaining(BUILD_ENTRIES));
});
