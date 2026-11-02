import type { SlashCommand } from "@trackwall/protocol";

/**
 * The slash commands the agent offers that start with what the user typed, above the message box: ↑ and ↓ pick one,
 * Tab or Enter puts it in the box, a click too. The agent runs a command the message starts with.
 */
export function SlashCommandList({
  commands,
  selected,
  onPick,
}: {
  commands: readonly SlashCommand[];
  selected: number;
  onPick: (command: SlashCommand) => void;
}) {
  return (
    <div role="listbox" aria-label="Slash commands" className="bg-overlay flex flex-col rounded-md border p-1 shadow-lg text-xs">
      {commands.map((command, i) => (
        <div
          key={command.name}
          role="option"
          aria-selected={i === selected}
          tabIndex={-1}
          className="aria-selected:bg-accent hover:bg-accent flex cursor-pointer items-baseline gap-2 rounded px-2 py-1"
          onMouseDown={(e) => {
            // Keeps the focus in the message box.
            e.preventDefault();
            onPick(command);
          }}
        >
          <code className="text-primary shrink-0 font-mono">/{command.name}</code>
          {command.hint && <span className="text-muted-foreground shrink-0 font-mono">{command.hint}</span>}
          <span className="text-muted-foreground truncate">{command.description}</span>
        </div>
      ))}
    </div>
  );
}
