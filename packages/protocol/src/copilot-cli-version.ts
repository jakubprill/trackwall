/**
 * The Copilot CLI version Trackwall is checked against: the contract tests download it (ADR-67), and the doctor warns about
 * an older one (ADR-101), which may lack what the daemon relies on. A newer Copilot CLI comes in a PR that raises it and
 * passes the contract tests on it. Alone in its file, because the contract job's cache of the binary is keyed on it.
 */
export const TESTED_COPILOT_CLI_VERSION = "1.0.103";
