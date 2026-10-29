import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../src/infra/errors.ts";
import {
  javaLanguageServer,
  javaNavigationProblem,
  javaNavigationReadiness,
  javaNavigationState,
  mavenOnlyImport,
} from "../src/modules/agents/java-language-server.ts";

/** A jdtls folder as its release archive unpacks: the launcher jar in `plugins/` and one configuration folder per system. */
function jdtlsFolder(): string {
  const jdtls = mkdtempSync(join(tmpdir(), "trackwall-jdtls-"));
  mkdirSync(join(jdtls, "plugins"));
  writeFileSync(join(jdtls, "plugins", "org.eclipse.jdt.ls.core_1.50.0.jar"), "");
  writeFileSync(join(jdtls, "plugins", "org.eclipse.equinox.launcher_1.7.100.v20251111.jar"), "");
  for (const config of ["config_win", "config_mac", "config_mac_arm", "config_linux", "config_linux_arm"]) mkdirSync(join(jdtls, config));
  return jdtls;
}

describe("the Java language server of a task (ADR-99)", () => {
  test("jdtls starts with java directly, on the launcher jar, with this system's configuration and the task's own data folder", () => {
    const jdtls = jdtlsFolder();
    const settings = { jdtls, java: "/opt/jdk-25/bin/java", lombok: null };

    const server = javaLanguageServer(settings, "/projects/.trackwall/lsp/task-1", false, "darwin", "arm64");

    expect(server.command).toBe("/opt/jdk-25/bin/java");
    expect(server.fileExtensions).toEqual({ ".java": "java" });
    expect(server.args).toContain(`-Dosgi.sharedConfiguration.area=${join(jdtls, "config_mac_arm")}`);
    expect(server.args).toContain("-Xmx2G");
    expect(server.args.slice(-6)).toEqual([
      "-jar",
      join(jdtls, "plugins", "org.eclipse.equinox.launcher_1.7.100.v20251111.jar"),
      "-configuration",
      join("/projects/.trackwall/lsp/task-1", "configuration"),
      "-data",
      join("/projects/.trackwall/lsp/task-1", "workspace"),
    ]);
    expect(server.args.some((arg) => arg.startsWith("-javaagent:"))).toBe(false);
    expect(server.initializationOptions).toBeUndefined();
  });

  test("each system gets its own jdtls configuration folder", () => {
    const jdtls = jdtlsFolder();
    const settings = { jdtls, java: "java", lombok: null };
    const configOf = (platform: NodeJS.Platform, arch: NodeJS.Architecture) =>
      javaLanguageServer(settings, "/data", false, platform, arch).args.find((arg) => arg.startsWith("-Dosgi.sharedConfiguration.area="));

    expect(configOf("win32", "x64")).toBe(`-Dosgi.sharedConfiguration.area=${join(jdtls, "config_win")}`);
    expect(configOf("darwin", "x64")).toBe(`-Dosgi.sharedConfiguration.area=${join(jdtls, "config_mac")}`);
    expect(configOf("linux", "x64")).toBe(`-Dosgi.sharedConfiguration.area=${join(jdtls, "config_linux")}`);
    expect(configOf("linux", "arm64")).toBe(`-Dosgi.sharedConfiguration.area=${join(jdtls, "config_linux_arm")}`);
  });

  test("Lombok, when set, is a Java agent before the launcher jar", () => {
    const jdtls = jdtlsFolder();
    const server = javaLanguageServer({ jdtls, java: "java", lombok: "/opt/lombok.jar" }, "/data", false, "linux", "x64");

    expect(server.args.indexOf("-javaagent:/opt/lombok.jar")).toBeLessThan(server.args.indexOf("-jar"));
  });

  test("the problem names what is missing: the Java program, the Lombok jar, the launcher jar or this system's configuration", () => {
    const jdtls = jdtlsFolder();
    const java = join(jdtls, "plugins", "org.eclipse.jdt.ls.core_1.50.0.jar");

    expect(javaNavigationProblem({ jdtls, java: join(jdtls, "no-java"), lombok: null })).toBe(
      `no Java program at ${join(jdtls, "no-java")}`,
    );
    expect(javaNavigationProblem({ jdtls, java, lombok: join(jdtls, "no-lombok.jar") })).toBe(
      `no Lombok jar at ${join(jdtls, "no-lombok.jar")}`,
    );
    expect(javaNavigationProblem({ jdtls: join(jdtls, "plugins"), java, lombok: null })).toBe(
      `no jdtls launcher jar in ${join(jdtls, "plugins", "plugins")}`,
    );
    const withoutConfigs = mkdtempSync(join(tmpdir(), "trackwall-jdtls-"));
    mkdirSync(join(withoutConfigs, "plugins"));
    writeFileSync(join(withoutConfigs, "plugins", "org.eclipse.equinox.launcher_1.7.0.jar"), "");
    expect(javaNavigationProblem({ jdtls: withoutConfigs, java, lombok: null }, "win32", "x64")).toBe(
      `no jdtls configuration for this system at ${join(withoutConfigs, "config_win")}`,
    );
    expect(javaNavigationProblem({ jdtls, java, lombok: null })).toBeNull();
  });

  test("readiness has the settings only when jdtls can start; a missing key or a bad one is a problem, and the form hears of a missing key as not set", () => {
    const jdtls = jdtlsFolder();
    const settings = { jdtls, java: join(jdtls, "plugins", "org.eclipse.jdt.ls.core_1.50.0.jar"), lombok: null };

    expect(javaNavigationReadiness(() => settings)).toEqual({ settings, problem: null });
    const unset = javaNavigationReadiness(() => null);
    expect(unset).toEqual({ settings: null, problem: "javaNavigation is not set in workspace.yaml" });
    expect(javaNavigationState(unset)).toBeNull();
    const invalid = javaNavigationReadiness(() => {
      throw new DomainError("invalid_config", "workspace.yaml: javaNavigation: jdtls, java and lombok must be full paths");
    });
    expect(invalid).toEqual({ settings: null, problem: "workspace.yaml: javaNavigation: jdtls, java and lombok must be full paths" });
    expect(javaNavigationState(invalid)).toEqual({ problem: "workspace.yaml: javaNavigation: jdtls, java and lombok must be full paths" });
    expect(javaNavigationState(javaNavigationReadiness(() => settings))).toEqual({ problem: null });
  });
});

describe("Maven before Gradle for jdtls's import (ADR-124)", () => {
  test("a project with a pom.xml and a Gradle build is imported with Maven only, and one with one build as jdtls chooses", () => {
    const both = mkdtempSync(join(tmpdir(), "trackwall-both-builds-"));
    writeFileSync(join(both, "pom.xml"), "<project/>");
    writeFileSync(join(both, "build.gradle.kts"), "");
    const gradle = mkdtempSync(join(tmpdir(), "trackwall-gradle-"));
    writeFileSync(join(gradle, "build.gradle"), "");
    const maven = mkdtempSync(join(tmpdir(), "trackwall-maven-"));
    writeFileSync(join(maven, "pom.xml"), "<project/>");

    expect([mavenOnlyImport(both), mavenOnlyImport(gradle), mavenOnlyImport(maven)]).toEqual([true, false, false]);
  });

  test("Maven only is jdtls's setting java.import.gradle.enabled: false, sent in its initialize request", () => {
    const settings = { jdtls: jdtlsFolder(), java: "java", lombok: null };
    expect(javaLanguageServer(settings, "/data", true).initializationOptions).toEqual({
      settings: { java: { import: { gradle: { enabled: false } } } },
    });
  });
});
