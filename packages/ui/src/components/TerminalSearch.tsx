import type { SearchAddon } from "@xterm/addon-search";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { searchKeyAction } from "@/lib/terminal-search";

/**
 * The search bar over a terminal (`PtyTerminal`): finds text on the screen and in the scrollback as it is typed, and
 * selects the match, so Ctrl+C or Cmd+C copies it. Closing it clears the match and gives the keyboard back to the terminal.
 */
export function TerminalSearch({ search, onClose }: { search: SearchAddon; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [missed, setMissed] = useState(false);
  const find = (direction: "previous" | "next", text = query) => {
    if (text === "") return setMissed(false);
    const found = direction === "next" ? search.findNext(text) : search.findPrevious(text);
    setMissed(!found);
  };
  const close = () => {
    search.clearDecorations();
    onClose();
  };
  return (
    <div className="bg-overlay absolute top-3 right-4 z-10 flex items-center gap-1 rounded-md border p-1 shadow-lg">
      <Input
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          find("previous", event.target.value);
        }}
        onKeyDown={(event) => {
          const action = searchKeyAction(event);
          if (!action) return;
          event.preventDefault();
          if (action === "close") close();
          else find(action);
        }}
        placeholder="Find"
        aria-label="Find in the terminal"
        aria-invalid={missed}
        className="h-7 w-48 text-xs"
      />
      {missed && <span className="text-muted-foreground px-1 text-xs">No match</span>}
      <Button variant="ghost" size="icon" onClick={() => find("previous")} aria-label="Previous match (Enter)">
        <ChevronUp />
      </Button>
      <Button variant="ghost" size="icon" onClick={() => find("next")} aria-label="Next match (Shift+Enter)">
        <ChevronDown />
      </Button>
      <Button variant="ghost" size="icon" onClick={close} aria-label="Close the search (Escape)">
        <X />
      </Button>
    </div>
  );
}
