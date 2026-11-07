import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONVENTION_BUILD_FILES, type ConventionTasksState } from "@trackwall/protocol";
import { writeFileAtomic } from "../../infra/atomic-write.ts";

/**
 * The convention tasks file (ADR-157, §4.7): the mise tasks `setup`, `build` and `test` that Verify, the Batch command and
 * agents expect, for repos whose own mise config has none. Trackwall writes it, on the user's click, into a `conf.d`
 * folder of the projects folder, where mise reads it for every repo and task worktree below: a mise task of the same name
 * in a repo's own config wins, since mise prefers the config nearer the working directory. Each mise task finds the
 * build in its working directory (`dir = "{{cwd}}"`, not the projects folder) by its build file: Maven, then Gradle, then
 * npm, and fails with a message when there is none, so a verification never passes on a repo it could not test. `test`
 * declares one optional argument, a test filter (ADR-158). No `dev`: every repo would then look like a service.
 */

/** Where mise reads the file in the projects folder: its lowest-precedence config there, under the user's own `mise.toml`. */
const CONVENTION_TASKS_PATH = [".config", "mise", "conf.d", "trackwall-convention-tasks.toml"] as const;

export function conventionTasksPath(projectsDir: string): string {
  return join(projectsDir, ...CONVENTION_TASKS_PATH);
}

const NO_BUILD = `no ${conventionBuildFiles()} here: give this repo its own mise task`;

/**
 * The file as this Trackwall writes it. POSIX `sh` scripts in `run` (macOS, Linux, the container) and one-line `cmd.exe`
 * scripts in `run_windows`, mise's default shells there (without variables set inside a line, which `cmd.exe` expands
 * before running it). On Windows a filter counts only when `usage_filter` is defined and not empty: outside a batch file
 * `cmd.exe` leaves an undefined `%usage_filter%` as it is. The test filter reaches the scripts only as the `usage_filter`
 * variable, quoted, never through a template, so even a value typed by hand in a terminal stays one argument.
 */
export const CONVENTION_TASKS = `# Convention tasks written by Trackwall (ADR-157): setup, build and test for Maven, Gradle and npm projects,
# for every repo in this projects folder whose own mise config has no task of that name (the repo's own task wins).
# Trackwall writes this file only when it is absent; once you edit it, Trackwall leaves it as it is.

[tasks.setup]
description = "Dependencies: npm ci for npm (Maven and Gradle download theirs in build and test) - Trackwall convention task"
dir = "{{cwd}}"
run = '''
if [ -f pom.xml ] || [ -f build.gradle ] || [ -f build.gradle.kts ]; then echo "Maven and Gradle download dependencies in build and test: nothing to set up"
elif [ -f package.json ]; then npm ci
else echo "${NO_BUILD}" >&2; exit 1
fi
'''
run_windows = 'if exist pom.xml (echo Maven and Gradle download dependencies in build and test: nothing to set up) else if exist build.gradle* (echo Maven and Gradle download dependencies in build and test: nothing to set up) else if exist package.json (call npm ci) else (echo ${NO_BUILD} 1>&2 & exit 1)'

[tasks.build]
description = "Build without tests: mvn package, gradle assemble or npm run build - Trackwall convention task"
dir = "{{cwd}}"
run = '''
if [ -f pom.xml ]; then if [ -f mvnw ]; then sh ./mvnw --batch-mode package -DskipTests; else mvn --batch-mode package -DskipTests; fi
elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then if [ -f gradlew ]; then sh ./gradlew assemble; else gradle assemble; fi
elif [ -f package.json ]; then npm run build
else echo "${NO_BUILD}" >&2; exit 1
fi
'''
run_windows = 'if exist pom.xml (if exist mvnw.cmd (call mvnw.cmd --batch-mode package -DskipTests) else (call mvn --batch-mode package -DskipTests)) else if exist build.gradle* (if exist gradlew.bat (call gradlew.bat assemble) else (call gradle assemble)) else if exist package.json (call npm run build) else (echo ${NO_BUILD} 1>&2 & exit 1)'

[tasks.test]
description = "Tests, or only those matching the filter (Maven -Dtest, Gradle --tests, npm test --) - Trackwall convention task"
dir = "{{cwd}}"
usage = 'arg "[filter]" help="Only the tests matching this filter, e.g. OrderServiceTest (Maven also OrderServiceTest#creates, Gradle OrderServiceTest.creates)"'
run = '''
if [ -f pom.xml ]; then
  if [ -f mvnw ]; then mvn="sh ./mvnw"; else mvn="mvn"; fi
  if [ -n "\${usage_filter:-}" ]; then $mvn --batch-mode test "-Dtest=$usage_filter" -Dsurefire.failIfNoSpecifiedTests=false; else $mvn --batch-mode test; fi
elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then
  if [ -f gradlew ]; then gradle="sh ./gradlew"; else gradle="gradle"; fi
  if [ -n "\${usage_filter:-}" ]; then $gradle test --tests "$usage_filter"; else $gradle test; fi
elif [ -f package.json ]; then
  if [ -n "\${usage_filter:-}" ]; then npm test -- "$usage_filter"; else npm test; fi
else echo "${NO_BUILD}" >&2; exit 1
fi
'''
run_windows = 'if exist pom.xml (if exist mvnw.cmd (if defined usage_filter (if not "%usage_filter%"=="" (call mvnw.cmd --batch-mode test "-Dtest=%usage_filter%" -Dsurefire.failIfNoSpecifiedTests=false) else (call mvnw.cmd --batch-mode test)) else (call mvnw.cmd --batch-mode test)) else (if defined usage_filter (if not "%usage_filter%"=="" (call mvn --batch-mode test "-Dtest=%usage_filter%" -Dsurefire.failIfNoSpecifiedTests=false) else (call mvn --batch-mode test)) else (call mvn --batch-mode test))) else if exist build.gradle* (if exist gradlew.bat (if defined usage_filter (if not "%usage_filter%"=="" (call gradlew.bat test --tests "%usage_filter%") else (call gradlew.bat test)) else (call gradlew.bat test)) else (if defined usage_filter (if not "%usage_filter%"=="" (call gradle test --tests "%usage_filter%") else (call gradle test)) else (call gradle test))) else if exist package.json (if defined usage_filter (if not "%usage_filter%"=="" (call npm test -- "%usage_filter%") else (call npm test)) else (call npm test)) else (echo ${NO_BUILD} 1>&2 & exit 1)'
`;

/** The state of the file in the projects folder: compared as text with what this Trackwall writes. */
export function conventionTasksState(projectsDir: string): ConventionTasksState {
  const path = conventionTasksPath(projectsDir);
  const text = readText(path);
  return { path, state: text === null ? "absent" : text === CONVENTION_TASKS ? "current" : "changed" };
}

/** Writes the file when it is absent; `false` when one is already there, which stays as it is. */
export function writeConventionTasks(projectsDir: string): boolean {
  const path = conventionTasksPath(projectsDir);
  if (readText(path) !== null) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomic(path, CONVENTION_TASKS);
  return true;
}

/**
 * The file as text, following a link: unlike a repo's local config (ADR-86), it lies in the projects folder, whose writer
 * could write the file itself, so a planted link gives nothing more (§8).
 */
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** `pom.xml, build.gradle, build.gradle.kts or package.json`, the list agent readiness checks too (ADR-208). */
function conventionBuildFiles(): string {
  return `${CONVENTION_BUILD_FILES.slice(0, -1).join(", ")} or ${CONVENTION_BUILD_FILES.at(-1)}`;
}
