import { agentsApi, type ConversationMode } from "@trackwall/protocol";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useAction } from "@/lib/use-action";

/**
 * The agent's modes (Agent, Plan) as one switch, as Shift+Tab switches them in the terminal; the mode shows as switched
 * once the agent says it works in it.
 */
export function AgentModeSwitch({ conn, session, mode }: { conn: Connection; session: string; mode: ConversationMode }) {
  const switchTo = useAction(
    (id: string) => post(conn, agentsApi.setMode, { session, mode: id }),
    () => {},
  );
  const current = mode.options.find((o) => o.id === mode.current);
  return (
    <span className="flex shrink-0 items-center gap-2">
      {/* biome-ignore lint/a11y/useSemanticElements: a group of toggle buttons, which fieldset would frame and pad. */}
      <span role="group" aria-label="Mode" className="flex overflow-hidden rounded-md border">
        {mode.options.map((option) => (
          <button
            key={option.id}
            type="button"
            title={option.description}
            aria-pressed={option.id === mode.current}
            disabled={switchTo.pending}
            className="text-muted-foreground hover:bg-accent aria-pressed:bg-accent aria-pressed:text-primary px-2 py-0.5 disabled:opacity-50"
            onClick={() => {
              if (option.id !== mode.current) switchTo.run(option.id);
            }}
          >
            {option.name}
          </button>
        ))}
      </span>
      {current === undefined && <span className="text-muted-foreground">Mode: other</span>}
      {switchTo.error && <span className="text-destructive">{switchTo.error}</span>}
    </span>
  );
}
