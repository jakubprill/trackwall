import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JavaNavigationInstall } from "@trackwall/protocol";
import { createFacade, type Facade } from "../src/facade.ts";
import { tarProgram } from "../src/infra/tar.ts";
import type { PinnedRelease } from "../src/modules/java-navigation/pinned-releases.ts";
import { makeRepo } from "./support/git-repo.ts";
import { fakeHostingClis } from "./support/hosting.ts";

const fakeMise = join(import.meta.dir, "fixtures", "fake-mise-tools.ts");

/** A jdtls release as small as it gets: the launcher jar and a configuration folder for every system. */
function jdtlsArchive(): Buffer {
  const root = mkdtempSync(join(tmpdir(), "trackwall-jdtls-release-"));
  const release = join(root, "release");
  mkdirSync(join(release, "plugins"), { recursive: true });
  writeFileSync(join(release, "plugins", "org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar"), "jar");
  for (const config of ["config_linux", "config_linux_arm", "config_mac", "config_mac_arm", "config_win"]) mkdirSync(join(release, config));
  const archive = join(root, "jdtls.tar.gz");
  const tar = spawnSync(tarProgram(process.platform, process.env), [
    "-czf",
    archive,
    "-C",
    release,
    "plugins",
    "config_linux",
    "config_linux_arm",
    "config_mac",
    "config_mac_arm",
    "config_win",
  ]);
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  return readFileSync(archive);
}

const archive = jdtlsArchive();
const sha256 = createHash("sha256").update(archive).digest("hex");
const lombokJar = Buffer.from("a Lombok jar");
let downloads = 0;
const server = createServer((req, res) => {
  if (req.url === "/lombok.jar") return void res.writeHead(200, { "content-type": "application/java-archive" }).end(lombokJar);
  if (req.url !== "/jdtls.tar.gz") return void res.writeHead(404).end();
  downloads++;
  res.writeHead(200, { "content-type": "application/gzip" }).end(archive);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const url = `${origin}/jdtls.tar.gz`;
const lombokRelease = { version: "1.18.48", url: `${origin}/lombok.jar`, sha256: createHash("sha256").update(lombokJar).digest("hex") };
afterAll(() => server.close());

/** A facade whose install downloads the local archive and installs Java with the fake mise. */
function installFacade(o: { release?: Partial<PinnedRelease>; miseError?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-java-install-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-java-install-projects-"));
  const installs = mkdtempSync(join(tmpdir(), "trackwall-java-install-mise-"));
  const facade = createFacade({
    inContainer: false,
    home,
    homeFrom: "flag",
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: [process.execPath, fakeMise],
    copilotCommand: ["trackwall-test-no-copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: fakeHostingClis({}).clis,
    userEnv: async () => ({
      ...process.env,
      FAKE_MISE_INSTALLS: installs,
      ...(o.miseError === undefined ? {} : { FAKE_MISE_INSTALL_ERROR: o.miseError }),
    }),
    jdtlsRelease: { version: "1.63.0", url, sha256, ...o.release },
    lombokRelease,
    log: () => {},
  });
  return { facade, projects, installs, lsp: join(projects, ".trackwall", "lsp") };
}

async function installed(facade: Facade): Promise<JavaNavigationInstall> {
  const until = Date.now() + 20_000;
  for (;;) {
    const install = facade.javaNavigation.state();
    if (install.step === null) return install;
    if (Date.now() > until) throw new Error(`the install did not end; last state ${JSON.stringify(install)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const javaName = process.platform === "win32" ? "java.exe" : "java";

describe("installing Java navigation from Settings (ADR-123)", () => {
  test("downloads jdtls and Lombok into the projects folder, installs Java with mise and saves the paths, so tasks can get it", async () => {
    const { facade, projects, installs, lsp } = installFacade();
    await facade.workspace.setProjectsDir(projects);
    expect(facade.javaNavigation.state()).toEqual({
      jdtls: "1.63.0",
      java: "temurin-25",
      lombok: "1.18.48",
      step: null,
      error: null,
      warning: null,
      readiness: null,
    });
    expect(facade.javaNavigation.startInstall().step).toBe("Starting");
    expect(await installed(facade)).toMatchObject({ step: null, error: null, warning: null, readiness: { problem: null } });
    const jdtls = join(lsp, "jdtls-1.63.0");
    expect(facade.workspace.javaNavigation()).toEqual({
      jdtls,
      java: join(installs, "java@temurin-25", "bin", javaName),
      lombok: join(lsp, "lombok-1.18.48.jar"),
      runtimes: [],
    });
    expect(readdirSync(join(jdtls, "plugins"))).toEqual(["org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar"]);
    expect(readFileSync(join(lsp, "lombok-1.18.48.jar"), "utf8")).toBe("a Lombok jar");
    expect(readdirSync(lsp).sort()).toEqual(["jdtls-1.63.0", "lombok-1.18.48.jar"]);
    // mise runs in an empty folder of the install's own and looks for no config above it, so no mise config takes part.
    const mise = JSON.parse(readFileSync(join(installs, "calls.log"), "utf8"));
    expect(mise.ceiling).toBe(mise.cwd);
    expect(mise.cwd.startsWith(join(realpathSync.native(lsp), ".install-"))).toBe(true);
    expect(facade.agents.javaNavigationState()).toEqual({ problem: null });
  });

  test("installing again downloads and checks the release again, replaces what is there and keeps the Lombok jar the user named", async () => {
    const { facade, projects, lsp } = installFacade();
    await facade.workspace.setProjectsDir(projects);
    facade.javaNavigation.startInstall();
    await installed(facade);
    const before = downloads;
    const planted = join(lsp, "jdtls-1.63.0", "plugins", "planted.jar");
    writeFileSync(planted, "not from the release");
    const lombok = join(projects, "lombok.jar");
    writeFileSync(lombok, "jar");
    const settings = facade.workspace.javaNavigation();
    if (settings === null) throw new Error("the first install saved no settings");
    facade.workspace.setJavaNavigation({ ...settings, java: join(projects, "gone", "java"), lombok });
    facade.javaNavigation.startInstall();
    expect(await installed(facade)).toMatchObject({ error: null, readiness: { problem: null } });
    expect(downloads).toBe(before + 1);
    expect(existsSync(planted)).toBe(false);
    expect(readdirSync(lsp).sort()).toEqual(["jdtls-1.63.0", "lombok-1.18.48.jar"]);
    expect(facade.workspace.javaNavigation()).toEqual({ ...settings, lombok });
  });

  test("a temporary folder left by a daemon that stopped mid-install is removed by the next install", async () => {
    const { facade, projects, lsp } = installFacade();
    await facade.workspace.setProjectsDir(projects);
    mkdirSync(join(lsp, ".install-left"), { recursive: true });
    facade.javaNavigation.startInstall();
    await installed(facade);
    expect(readdirSync(lsp).sort()).toEqual(["jdtls-1.63.0", "lombok-1.18.48.jar"]);
  });

  test("installs with mise the Java versions the repos build with, gives them to jdtls and names those mise could not install", async () => {
    const { facade, projects, installs } = installFacade({ miseError: "java@temurin-8: no Temurin 8 build for this system" });
    makeRepo(
      { "pom.xml": "<project><artifactId>orders</artifactId><properties><java.version>17</java.version></properties></project>" },
      "orders",
      projects,
    );
    makeRepo({ "build.gradle": "java {\n  toolchain {\n    languageVersion = JavaLanguageVersion.of(8)\n  }\n}\n" }, "legacy", projects);
    await facade.workspace.setProjectsDir(projects);
    facade.javaNavigation.startInstall();
    const install = await installed(facade);
    expect(install).toMatchObject({
      error: null,
      warning: "mise could not install Java 8: mise ERROR java@temurin-8: no Temurin 8 build for this system",
      readiness: { problem: null },
    });
    expect(facade.workspace.javaNavigation()?.runtimes).toEqual([join(installs, "java@temurin-17")]);
  });

  test("installing again keeps one runtime per Java version, the installed one first, and replaces the Lombok jar it installed itself", async () => {
    const { facade, projects, installs, lsp } = installFacade();
    makeRepo({ "pom.xml": "<project><properties><java.version>17</java.version></properties></project>" }, "orders", projects);
    await facade.workspace.setProjectsDir(projects);
    facade.javaNavigation.startInstall();
    await installed(facade);
    const settings = facade.workspace.javaNavigation();
    if (settings === null) throw new Error("the first install saved no settings");
    const ownJdk17 = join(projects, "jdk-17");
    const ownJdk11 = join(projects, "jdk-11");
    mkdirSync(ownJdk17);
    writeFileSync(join(ownJdk17, "release"), 'JAVA_VERSION="17.0.9"\n');
    mkdirSync(ownJdk11);
    writeFileSync(join(ownJdk11, "release"), 'JAVA_VERSION="11.0.21"\n');
    facade.workspace.setJavaNavigation({ ...settings, runtimes: [...settings.runtimes, ownJdk17, ownJdk11, join(projects, "gone")] });

    facade.javaNavigation.startInstall();
    expect(await installed(facade)).toMatchObject({ error: null, readiness: { problem: null } });
    expect(facade.workspace.javaNavigation()).toEqual({
      ...settings,
      lombok: join(lsp, "lombok-1.18.48.jar"),
      runtimes: [join(installs, "java@temurin-17"), ownJdk11],
    });
  });

  test("an archive whose SHA-256 differs from the pinned one fails the install and leaves nothing behind", async () => {
    const { facade, projects, lsp } = installFacade({ release: { sha256: "0".repeat(64) } });
    await facade.workspace.setProjectsDir(projects);
    facade.javaNavigation.startInstall();
    const install = await installed(facade);
    expect(install.error).toBe(`${url} has SHA-256 ${sha256}, not the expected ${"0".repeat(64)}`);
    expect(install.readiness).toBeNull();
    expect(readdirSync(lsp)).toEqual([]);
    expect(facade.workspace.javaNavigation()).toBeNull();
  });

  test("a mise that cannot install Java fails the install with mise's message and changes no settings", async () => {
    const { facade, projects, lsp } = installFacade({ miseError: "temurin-25: HTTP 503 from api.adoptium.net" });
    await facade.workspace.setProjectsDir(projects);
    facade.javaNavigation.startInstall();
    expect((await installed(facade)).error).toBe("mise ERROR temurin-25: HTTP 503 from api.adoptium.net");
    expect(existsSync(join(lsp, "jdtls-1.63.0", "plugins"))).toBe(true);
    expect(facade.workspace.javaNavigation()).toBeNull();
  });

  test("a runtime path with a comma is a bad key, since Gradle takes the runtimes as one comma-separated list", () => {
    const { facade, projects } = installFacade();
    const java = join(projects, "java");
    facade.workspace.setJavaNavigation({ jdtls: projects, java, lombok: null, runtimes: [join(projects, "jdk,17")] });
    expect(() => facade.workspace.javaNavigation()).toThrow("a runtimes path must not contain a comma");
  });

  test("without a projects folder the install says where to set it", async () => {
    const { facade } = installFacade();
    facade.javaNavigation.startInstall();
    expect((await installed(facade)).error).toMatch(/projects folder/i);
  });
});
