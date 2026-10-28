import { join } from "node:path";

const TEMP_VARIABLES = ["TMPDIR", "TEMP", "TMP"] as const;

/**
 * Runs `run` while the system temp folder (`os.tmpdir()`) points at a folder that does not exist, so that any file
 * written there fails: the proof that git's scratch files stay in the scratch folder (clarification to ADR-31).
 */
export async function withTempFolderGone<T>(run: () => Promise<T>): Promise<T> {
  const saved = TEMP_VARIABLES.map((name) => [name, process.env[name]] as const);
  const gone = join(process.cwd(), "no-such-temp-folder");
  for (const name of TEMP_VARIABLES) process.env[name] = gone;
  try {
    return await run();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
