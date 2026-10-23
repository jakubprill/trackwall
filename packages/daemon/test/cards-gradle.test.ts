import { describe, expect, test } from "bun:test";
import { extractGradle } from "../src/modules/cards/gradle.ts";
import { snapshotOf } from "./support/snapshot.ts";

const SETTINGS = `rootProject.name = "catalog"
include("catalog-api", ":catalog-app")
// include("wylaczony")
`;

const ROOT_BUILD = `plugins {
    id("org.springframework.boot") version "3.3.0" apply false
    java
}
allprojects {
    group = "com.example.catalog"
    version = "2.0.0"
}
`;

const APP_BUILD = `plugins {
    alias(libs.plugins.spring.boot)
}
java {
    toolchain { languageVersion = JavaLanguageVersion.of(21) }
}
dependencies {
    implementation(project(":catalog-api"))
    implementation("com.example.catalog:catalog-api:2.0.0")
    implementation(platform("org.springframework.cloud:spring-cloud-dependencies:2023.0.2"))
    implementation(libs.spring.kafka)
    implementation 'org.springframework.cloud:spring-cloud-starter-openfeign'
    /* testImplementation("com.example:wylaczona:1.0") */
    testImplementation(libs.junit)
}
`;

const CATALOG = `[versions]
kafka = "3.2.1"
boot = "3.3.0"

[libraries]
spring-kafka = { module = "org.springframework.kafka:spring-kafka", version.ref = "kafka" }
junit = "org.junit.jupiter:junit-jupiter:5.10.2"

[plugins]
spring-boot = { id = "org.springframework.boot", version.ref = "boot" }
`;

describe("ekstraktor Gradle", () => {
  const snapshot = snapshotOf({
    "settings.gradle.kts": SETTINGS,
    "build.gradle.kts": ROOT_BUILD,
    "catalog-api/build.gradle.kts": "plugins { `java-library` }\n",
    "catalog-app/build.gradle.kts": APP_BUILD,
    "gradle/libs.versions.toml": CATALOG,
  });

  test("projekty z include udostępniają grupę z projektu głównego i swoją nazwę", () => {
    const out = extractGradle(snapshot);
    expect(out.provides.map((p) => [p.name, p.version])).toEqual([
      ["com.example.catalog:catalog", "2.0.0"],
      ["com.example.catalog:catalog-api", "2.0.0"],
      ["com.example.catalog:catalog-app", "2.0.0"],
    ]);
    expect(out.buildFiles).toEqual([
      { path: "build.gradle.kts", tool: "gradle", name: "catalog", memberOf: null },
      { path: "catalog-api/build.gradle.kts", tool: "gradle", name: "catalog-api", memberOf: "build.gradle.kts" },
      { path: "catalog-app/build.gradle.kts", tool: "gradle", name: "catalog-app", memberOf: "build.gradle.kts" },
    ]);
  });

  test("zależności wprost, z platform() i z katalogu wersji; wtyczki z id i aliasu; projekty z repo i komentarze pominięte", () => {
    const out = extractGradle(snapshot);
    expect(out.consumes.map((c) => [c.ecosystem, c.name, c.version, c.scope, c.evidence.path, c.evidence.line])).toEqual([
      ["gradle-plugin", "org.springframework.boot", "3.3.0", "plugin", "build.gradle.kts", 2],
      ["gradle-plugin", "org.springframework.boot", "3.3.0", "plugin", "catalog-app/build.gradle.kts", 2],
      ["maven", "org.springframework.cloud:spring-cloud-dependencies", "2023.0.2", "implementation", "catalog-app/build.gradle.kts", 10],
      ["maven", "org.springframework.kafka:spring-kafka", "3.2.1", "implementation", "catalog-app/build.gradle.kts", 11],
      ["maven", "org.springframework.cloud:spring-cloud-starter-openfeign", null, "implementation", "catalog-app/build.gradle.kts", 12],
      ["maven", "org.junit.jupiter:junit-jupiter", "5.10.2", "testImplementation", "catalog-app/build.gradle.kts", 14],
    ]);
  });

  test("wersja Javy z toolchaina to podpowiedź narzędzia", () => {
    expect(extractGradle(snapshot).tools).toEqual([
      { tool: "java", version: "21", source: "hint", evidence: { path: "catalog-app/build.gradle.kts", line: 5 } },
    ]);
  });

  test("Groovy bez settings: jeden projekt bez nazwy, więc bez współrzędnych, ale z wtyczką z bloku w jednej linii i zależnościami", () => {
    const out = extractGradle(
      snapshotOf({
        "build.gradle":
          "plugins { id 'org.springframework.boot' version '3.3.0' }\ngroup 'com.example'\nsourceCompatibility = '1.8'\ndependencies {\n  compileOnly 'org.projectlombok:lombok:1.18.32'\n}\n",
      }),
    );
    expect(out.provides).toEqual([]);
    expect(out.consumes.map((c) => c.name)).toEqual(["org.springframework.boot", "org.projectlombok:lombok"]);
    expect(out.tools.map((t) => [t.tool, t.version])).toEqual([["java", "8"]]);
  });

  test("/* w napisie (wzorzec ścieżki) nie zaczyna komentarza i nie wyłącza reszty pliku", () => {
    const out = extractGradle(
      snapshotOf({
        "build.gradle": "jar { exclude 'META-INF/*.SF' }\ndependencies {\n  implementation 'com.example:lib:1.0' // */ w komentarzu\n}\n",
      }),
    );
    expect(out.consumes.map((c) => [c.name, c.evidence.line])).toEqual([["com.example:lib", 3]]);
  });

  test("include w settings rozpisany na wiele linii wymienia wszystkie projekty", () => {
    const out = extractGradle(
      snapshotOf({
        "settings.gradle.kts": 'rootProject.name = "shop"\ninclude(\n    ":app",\n    ":core",\n)\n',
        "build.gradle.kts": "",
        "app/build.gradle.kts": "",
        "core/build.gradle.kts": "",
      }),
    );
    expect(out.buildFiles.map((f) => [f.path, f.memberOf])).toEqual([
      ["build.gradle.kts", null],
      ["app/build.gradle.kts", "build.gradle.kts"],
      ["core/build.gradle.kts", "build.gradle.kts"],
    ]);
    const groovy = extractGradle(
      snapshotOf({
        "settings.gradle": "include 'app',\n        'core'\n",
        "build.gradle": "",
        "app/build.gradle": "",
        "core/build.gradle": "",
      }),
    );
    expect(groovy.buildFiles.map((f) => f.path)).toEqual(["build.gradle", "app/build.gradle", "core/build.gradle"]);
  });

  test("JavaVersion.VERSION_1_8 to Java 8", () => {
    const out = extractGradle(snapshotOf({ "build.gradle": "sourceCompatibility = JavaVersion.VERSION_1_8\n" }));
    expect(out.tools.map((t) => t.version)).toEqual(["8"]);
  });

  test("nawias w napisie nie przedłuża include na następne linie", () => {
    const out = extractGradle(
      snapshotOf({
        "settings.gradle.kts": 'include("app(")\nval y = "core"\n',
        "build.gradle.kts": "",
        "app(/build.gradle.kts": "",
        "core/build.gradle.kts": "",
      }),
    );
    expect(out.buildFiles.map((f) => f.path)).toEqual(["build.gradle.kts", "app(/build.gradle.kts"]);
  });

  test("surowy napis Kotlin z ukośnikiem wstecznym kończy się na potrójnym cudzysłowie", () => {
    const out = extractGradle(snapshotOf({ "build.gradle.kts": 'val dir = """C:\\"""\n// implementation("com.example:wylaczona:1.0")\n' }));
    expect(out.consumes).toEqual([]);
  });

  test("version.ref do nazwy z prototypu obiektu (constructor) to brak wersji, nie funkcja", () => {
    const out = extractGradle(
      snapshotOf({
        "build.gradle.kts": "dependencies {\n    implementation(libs.lib)\n}\n",
        "gradle/libs.versions.toml": '[libraries]\nlib = { module = "com.example:lib", version.ref = "constructor" }\n',
      }),
    );
    expect(out.consumes.map((c) => [c.name, c.version])).toEqual([["com.example:lib", null]]);
  });
});
