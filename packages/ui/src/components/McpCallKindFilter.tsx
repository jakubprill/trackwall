import { Button } from "@/components/ui/button";
import { MCP_CALL_FILTERS, type McpCallFilter } from "@/lib/mcp-calls";

/**
 * All, Changes or Errors over the MCP calls of the audit (ADR-152), the same buttons in Settings › Usage and in a task's
 * panel.
 */
export function McpCallKindFilter({ value, onChange }: { value: McpCallFilter; onChange: (filter: McpCallFilter) => void }) {
  return (
    <fieldset aria-label="Show calls" className="flex gap-1">
      {MCP_CALL_FILTERS.map((f) => (
        <Button
          key={f.id}
          size="sm"
          variant={f.id === value ? "secondary" : "ghost"}
          aria-pressed={f.id === value}
          onClick={() => onChange(f.id)}
        >
          {f.label}
        </Button>
      ))}
    </fieldset>
  );
}
