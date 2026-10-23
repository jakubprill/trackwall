import { describe, expect, test } from "bun:test";
import { copilotMcpAddCommand, copilotMcpConfig } from "../src/lib/copilot-mcp.ts";

describe("podłączenie Copilot CLI", () => {
  test("komenda copilot mcp add z binarką z wydania na macOS", () => {
    expect(copilotMcpAddCommand(["/Applications/Trackwall.app/Contents/MacOS/trackwall-daemon", "mcp-stdio"], "darwin")).toBe(
      "copilot mcp add trackwall -- /Applications/Trackwall.app/Contents/MacOS/trackwall-daemon mcp-stdio",
    );
  });

  test("ścieżka ze spacją i apostrofem w PowerShell na Windowsie", () => {
    expect(
      copilotMcpAddCommand(["C:\\Users\\Jan O'Neill\\AppData\\Local\\Programs\\trackwall\\trackwall-daemon.exe", "mcp-stdio"], "win32"),
    ).toBe("copilot mcp add trackwall -- 'C:\\Users\\Jan O''Neill\\AppData\\Local\\Programs\\trackwall\\trackwall-daemon.exe' mcp-stdio");
  });

  test("apostrof w ścieżce w powłoce POSIX", () => {
    expect(copilotMcpAddCommand(["/Users/o'neill/trackwall-daemon", "mcp-stdio"], "darwin")).toBe(
      "copilot mcp add trackwall -- '/Users/o'\\''neill/trackwall-daemon' mcp-stdio",
    );
  });

  test("wpis do mcp-config.json z programem i argumentami mostu", () => {
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
