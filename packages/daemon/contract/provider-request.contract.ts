import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copilotCli, PINNED_COPILOT_ENV } from "../scripts/copilot-cli.ts";
import { providerRequest } from "../src/modules/provider-models/provider-request.ts";
import { SCRIPTED_MODEL, type ScriptedModel, startScriptedModel } from "./support/scripted-model.ts";

// The contract of the provider's model list (ADR-194): the daemon asks the provider for its models with the credentials
// and headers a session's Copilot CLI sends it, read from the same variables. Copilot CLI runs here alone, with one
// prompt, since what matters is the request it sends the provider, not the daemon around it.

setDefaultTimeout(120_000);

let model: ScriptedModel;

beforeAll(async () => {
  model = await startScriptedModel();
});

afterAll(() => model.close());

/**
 * Runs Copilot CLI once with `-p` against the scripted model, with the provider variables of `provider` on top, and
 * gives its exit code.
 */
async function promptOnce(provider: Record<string, string>): Promise<number | null> {
  const home = mkdtempSync(join(tmpdir(), "trackwall-provider-contract-"));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("COPILOT_")));
  const env = {
    ...inherited,
    ...PINNED_COPILOT_ENV,
    COPILOT_HOME: join(home, "copilot-home"),
    COPILOT_OFFLINE: "true",
    COPILOT_MODEL: SCRIPTED_MODEL,
    COPILOT_PROVIDER_BASE_URL: model.url,
    ...provider,
  };
  const copilot = spawn(await copilotCli(), ["-p", "say hello", "--no-custom-instructions"], { cwd: home, env, stdio: "ignore" });
  return new Promise<number | null>((resolve) => copilot.once("exit", resolve));
}

describe("what Copilot CLI sends a custom provider, which the provider's model list sends too (ADR-194)", () => {
  test("a bearer token goes before the API key as Authorization, the extra headers come along, and no models list is asked for", async () => {
    const provider = {
      COPILOT_PROVIDER_API_KEY: "key-not-sent",
      COPILOT_PROVIDER_BEARER_TOKEN: "bearer-sent",
      COPILOT_PROVIDER_HEADERS: "X-Tenant: team-a\\nX-Route: chat",
    };
    model.reply({ text: "Hello." });

    expect(await promptOnce(provider)).toBe(0);

    const sent = model.requests().at(-1)?.headers;
    const daemon = providerRequest({ COPILOT_PROVIDER_BASE_URL: model.url, ...provider }, "byok");
    if (daemon.kind !== "request") throw new Error(`the daemon builds no request: ${daemon.kind}`);
    for (const [name, value] of Object.entries(daemon.headers)) expect(sent?.[name.toLowerCase()]).toBe(value);
    // The scripted model refuses anything but POST /chat/completions, so a GET of /models would be a problem here.
    expect(model.takeLeftovers()).toEqual({ problems: [], unusedReplies: 0 });
  });

  test("an API key alone goes as a bearer token", async () => {
    const provider = { COPILOT_PROVIDER_API_KEY: "key-sent" };
    model.reply({ text: "Hello." });

    expect(await promptOnce(provider)).toBe(0);

    expect(model.requests().at(-1)?.headers.authorization).toBe("Bearer key-sent");
    expect(providerRequest({ COPILOT_PROVIDER_BASE_URL: model.url, ...provider }, "byok")).toMatchObject({
      headers: { Authorization: "Bearer key-sent" },
    });
    expect(model.takeLeftovers()).toEqual({ problems: [], unusedReplies: 0 });
  });

  test("the format of COPILOT_PROVIDER_WIRE_API, which a session's start sets for its model (ADR-200), chooses the path Copilot CLI posts to", async () => {
    // The scripted model speaks only Chat Completions, so a request in the Responses API is refused (Copilot CLI tries
    // it again after the 500) and kept as a problem, and no Chat Completions request comes.
    const before = model.requests().length;
    await promptOnce({ COPILOT_PROVIDER_WIRE_API: "responses" });

    const { problems } = model.takeLeftovers();
    expect(problems.length).toBeGreaterThan(0);
    expect(new Set(problems)).toEqual(new Set(["POST /v1/responses"]));
    expect(model.requests()).toHaveLength(before);
  });

  test("with a custom provider, Copilot CLI refuses the model auto before any request, so the Model fields do not suggest it", async () => {
    // On Copilot CLI 1.0.103 it went to the provider as the model id; 1.0.107 resolves it itself and gives up.
    const before = model.requests().length;

    expect(await promptOnce({ COPILOT_MODEL: "auto" })).toBe(1);

    expect(model.requests()).toHaveLength(before);
    expect(model.takeLeftovers()).toEqual({ problems: [], unusedReplies: 0 });
  });
});
