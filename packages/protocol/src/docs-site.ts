/**
 * The documentation site (`apps/docs`, published on GitHub Pages). Agents get these addresses in the MCP instruction,
 * so they can look up what Trackwall can do; the site takes its base path from here. `llms.txt` is the site's index
 * for AI tools.
 */
export const TRACKWALL_DOCS_URL = "https://jakubprill.github.io/trackwall/";
export const TRACKWALL_DOCS_LLMS_URL = `${TRACKWALL_DOCS_URL}llms.txt`;
