# Reporting a vulnerability

Report vulnerabilities privately through [GitHub Security Advisories](https://github.com/jakubprill/trackwall/security/advisories/new) ("Report a vulnerability" on the Security tab), not in a public issue or pull request.

Include the Trackwall version, the system (Windows or macOS), steps to reproduce and what an attacker can do with it. Do not paste real secrets, tokens or names of private repositories; anonymize logs.

## Scope

Only the latest release on [GitHub Releases](https://github.com/jakubprill/trackwall/releases) gets fixes.

We are especially interested in:

- access to the daemon's API, WebSocket or MCP endpoint without the token or from outside `127.0.0.1` (`Host`/`Origin` checks, DNS rebinding, CSRF);
- running a command that is not in the configuration, or a process outside a repo or worktree (other than the interactive terminal in the UI, which by design runs what the user types);
- secrets leaking into agent sessions, logs, the audit trail or error messages;
- changing the daemon's configuration through an MCP tool.

The threat model is described in `docs/architecture.md` §8.

Trackwall is maintained by one person, so a reply may take a few days.
