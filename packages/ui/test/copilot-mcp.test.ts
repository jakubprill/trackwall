import { describe, expect, test } from "bun:test";
import { copilotMcpAddCommand, copilotMcpConfig, copilotMcpConfigPath } from "../src/lib/copilot-mcp.ts";

describe("connecting Copilot CLI", () => {
  test("copilot mcp add command with the release binary on macOS", () => {
    expect(copilotMcpAddCommand(["/Applications/Trackwall.app/Contents/MacOS/trackwall-daemon", "mcp-stdio"], "darwin")).toBe(
      "copilot mcp add trackwall -- /Applications/Trackwall.app/Contents/MacOS/trackwall-daemon mcp-stdio",
    );
  });

  test("a path with a space and an apostrophe in PowerShell on Windows", () => {
    expect(
      copilotMcpAddCommand(["C:\\Users\\Jan O'Neill\\AppData\\Local\\Programs\\trackwall\\trackwall-daemon.exe", "mcp-stdio"], "win32"),
    ).toBe("copilot mcp add trackwall '--' 'C:\\Users\\Jan O''Neill\\AppData\\Local\\Programs\\trackwall\\trackwall-daemon.exe' mcp-stdio");
  });

  test("a comma in the path and the bridge options from source quoted in PowerShell", () => {
    expect(
      copilotMcpAddCommand(
        ["C:\\Users\\Kowalski, Jan\\bun.exe", "--config=C:\\src\\bunfig.toml", "C:\\src\\main.ts", "mcp-stdio", "--home", "@dev"],
        "win32",
      ),
    ).toBe(
      "copilot mcp add trackwall '--' 'C:\\Users\\Kowalski, Jan\\bun.exe' '--config=C:\\src\\bunfig.toml' C:\\src\\main.ts mcp-stdio '--home' '@dev'",
    );
  });

  test("a typographic apostrophe in the path is doubled in PowerShell", () => {
    expect(copilotMcpAddCommand(["C:\\Users\\O\u2019Neill\\trackwall-daemon.exe", "mcp-stdio"], "win32")).toBe(
      "copilot mcp add trackwall '--' 'C:\\Users\\O\u2019\u2019Neill\\trackwall-daemon.exe' mcp-stdio",
    );
  });

  test("the config file in the notation of the user's system", () => {
    expect(copilotMcpConfigPath("win32")).toBe("%USERPROFILE%\\.copilot\\mcp-config.json");
    expect(copilotMcpConfigPath("darwin")).toBe("~/.copilot/mcp-config.json");
  });

  test("an apostrophe in the path in a POSIX shell", () => {
    expect(copilotMcpAddCommand(["/Users/o'neill/trackwall-daemon", "mcp-stdio"], "darwin")).toBe(
      "copilot mcp add trackwall -- '/Users/o'\\''neill/trackwall-daemon' mcp-stdio",
    );
  });

  test("an mcp-config.json entry with the bridge program and arguments", () => {
    expect(JSON.parse(copilotMcpConfig(["/opt/bun", "--no-env-file", "/src/main.ts", "mcp-stdio", "--home", "/dev-home"]))).toEqual({
      mcpServers: {
        trackwall: {
          type: "local",
          command: "/opt/bun",
          args: ["--no-env-file", "/src/main.ts", "mcp-stdio", "--home", "/dev-home"],
          tools: ["*"],
        },
      },
    });
  });
});
