import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { featureFiles } from "../scripts/feature.ts";

const source = join(import.meta.dir, "..", "devcontainer-feature");
const templates = {
  json: readFileSync(join(source, "devcontainer-feature.json"), "utf8"),
  install: readFileSync(join(source, "install.sh"), "utf8"),
};
const values = {
  version: "1.2.3",
  releaseUrl: "https://github.com/owner/trackwall/releases/download/v1.2.3",
  docsUrl: "https://owner.github.io/trackwall/guide/dev-container",
  sha256: { x64: "a".repeat(64), arm64: "" },
};

describe("the Dev Container Feature (ADR-164)", () => {
  test("gets the release's version, address and the SHA-256 of each archive written in, with nothing left to fill", () => {
    const files = featureFiles(templates, values);
    expect(JSON.parse(files.json)).toMatchObject({
      id: "trackwall",
      version: "1.2.3",
      documentationURL: values.docsUrl,
      options: { port: { default: "7700" } },
      postStartCommand: "trackwall-container start",
    });
    expect(files.install).toContain("VERSION='1.2.3'\n");
    expect(files.install).toContain(`RELEASE_URL='${values.releaseUrl}'\n`);
    expect(files.install).toContain(`SHA256_X64='${"a".repeat(64)}'\n`);
    expect(files.install).toContain("SHA256_ARM64=''\n");
    expect(files.install).not.toMatch(/@[A-Z0-9_]+@/);
  });

  test("starts Trackwall at every start of the container, not only when VS Code runs postStartCommand", () => {
    const files = featureFiles(templates, values);
    expect(JSON.parse(files.json).entrypoint).toBe("/usr/local/share/trackwall/entrypoint.sh");
    expect(files.install).toContain("cat > /usr/local/share/trackwall/entrypoint.sh << 'ENTRYPOINT'");
    expect(files.install).toContain('/usr/local/bin/trackwall-container start > /dev/null &\nexec "$@"\n');
  });

  test("runs the container with an init process, so the stopped sessions' orphans are reaped and their group counts as stopped", () => {
    expect(JSON.parse(featureFiles(templates, values).json).init).toBe(true);
  });

  test("refuses a value that would break out of its quotes in install.sh, and a placeholder it has no value for", () => {
    expect(() => featureFiles(templates, { ...values, version: "1.2.3'; rm -rf /; '" })).toThrow("unexpected version");
    expect(() => featureFiles(templates, { ...values, releaseUrl: "https://x/'$(id)'" })).toThrow("plain https addresses");
    expect(() => featureFiles(templates, { ...values, sha256: { x64: "not-a-sum", arm64: "" } })).toThrow("unexpected SHA-256");
    expect(() => featureFiles({ json: "@OTHER@", install: "" }, values)).toThrow("no value for @OTHER@");
  });
  test("offers the sandbox's programs as an option, off unless the user asks (ADR-219)", () => {
    expect(JSON.parse(featureFiles(templates, values).json).options.sandbox).toMatchObject({ type: "boolean", default: false });
    expect(featureFiles(templates, values).install).toContain(
      "apt-get install -y -qq --no-install-recommends bubblewrap slirp4netns iproute2 iptables util-linux",
    );
  });

  test.skipIf(process.platform === "win32")(
    "stops the image build on a sandbox value that is not true or false, before it installs anything",
    () => {
      const install = join(mkdtempSync(join(tmpdir(), "trackwall-feature-")), "install.sh");
      writeFileSync(install, featureFiles(templates, values).install);
      const run = spawnSync("sh", [install], { env: { ...process.env, SANDBOX: "yes" }, encoding: "utf8" });
      expect({ status: run.status, stderr: run.stderr }).toEqual({
        status: 1,
        stderr: "trackwall feature: sandbox must be true or false, got 'yes'\n",
      });
    },
  );
});
