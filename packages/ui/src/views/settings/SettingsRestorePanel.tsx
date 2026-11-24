import { localConfigApi, type SettingsRestore, type SettingsRestoreItem } from "@trackwall/protocol";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { DIFF_LINE_CLASSES } from "@/lib/diff-lines";
import { initiallyTicked, type RestoreLine, restoreGroups, restoreLines } from "@/lib/settings-restore";
import { useAction } from "@/lib/use-action";
import { cn } from "@/lib/utils";

const LINE_CLASSES: Record<RestoreLine["kind"], string> = {
  same: DIFF_LINE_CLASSES.context,
  removed: DIFF_LINE_CLASSES.removed,
  added: DIFF_LINE_CLASSES.added,
};

const LINE_MARKS: Record<RestoreLine["kind"], string> = { same: " ", removed: "-", added: "+" };

/**
 * Bringing the user's settings back from the workspace store (ADR-299): what differs from this computer, line by line,
 * and a restore of the items the user ticked, from the commit they looked at.
 */
export function SettingsRestorePanel({ conn }: { conn: Connection }) {
  const [offer, setOffer] = useState<SettingsRestore>();
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [restored, setRestored] = useState(0);
  const show = (next: SettingsRestore) => {
    setOffer(next);
    setTicked(initiallyTicked(next.items));
  };
  const look = useAction(
    () => post(conn, localConfigApi.settingsRestore, {}),
    (next) => {
      setRestored(0);
      show(next);
    },
  );
  const restore = useAction(
    (commit: string, items: string[]) => post(conn, localConfigApi.restoreSettings, { commit, items }),
    (next) => {
      setRestored(ticked.size);
      show(next);
    },
  );
  const tick = (id: string, on: boolean) =>
    setTicked((before) => {
      const after = new Set(before);
      if (on) after.add(id);
      else after.delete(id);
      return after;
    });
  const { plain, trust } = restoreGroups(offer?.items ?? []);
  const commit = offer?.commit ?? null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={look.pending} onClick={() => look.run()}>
          {offer ? "Look again" : "Restore settings from the store…"}
        </Button>
        {look.error && <p className="text-destructive text-xs">{look.error}</p>}
      </div>
      {restored > 0 && <p className="text-sm">Restored {restored === 1 ? "1 setting" : `${restored} settings`}.</p>}
      {offer && offer.items.length === 0 && (
        <p className="text-muted-foreground text-xs">This computer's settings are the same as the store's.</p>
      )}
      {plain.length > 0 && <RestoreItems items={plain} ticked={ticked} onTick={tick} />}
      {trust.length > 0 && (
        <>
          <p className="text-warning text-xs">
            These decide what agents may run or read. An agent can commit to the store, so tick one only after reading what it brings.
          </p>
          <RestoreItems items={trust} ticked={ticked} onTick={tick} />
        </>
      )}
      {commit !== null && (offer?.items.length ?? 0) > 0 && (
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={restore.pending || ticked.size === 0} onClick={() => restore.run(commit, [...ticked])}>
            Restore ticked settings
          </Button>
          {restore.error && <p className="text-destructive text-xs">{restore.error}</p>}
        </div>
      )}
    </div>
  );
}

function RestoreItems({
  items,
  ticked,
  onTick,
}: {
  items: SettingsRestoreItem[];
  ticked: Set<string>;
  onTick: (id: string, on: boolean) => void;
}) {
  return (
    <ul className="flex flex-col gap-2">
      {items.map((item) => (
        <RestoreItem key={item.id} item={item} ticked={ticked.has(item.id)} onTick={onTick} />
      ))}
    </ul>
  );
}

/** One item; its lines are worked out once per item, not on every tick of another one. */
function RestoreItem({ item, ticked, onTick }: { item: SettingsRestoreItem; ticked: boolean; onTick: (id: string, on: boolean) => void }) {
  const lines = useMemo(() => restoreLines(item.current, item.restored), [item.current, item.restored]);
  return (
    <li className="flex flex-col gap-1">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          className="accent-primary size-4 shrink-0"
          checked={ticked}
          disabled={item.problem !== null}
          onChange={(e) => onTick(item.id, e.target.checked)}
        />
        {item.label}
      </label>
      {item.problem && <p className="text-destructive text-xs">{item.problem}</p>}
      {item.stillMasked && (
        <p className="text-muted-foreground text-xs">
          Some values were masked in the store and this computer has none to put back: fill them in after the restore.
        </p>
      )}
      {lines.length > 0 && (
        <pre className="bg-muted max-h-60 overflow-auto rounded-md p-2 font-mono text-xs">
          {lines.map((line, i) => (
            <div key={`${i}:${line.kind}`} className={cn("whitespace-pre", LINE_CLASSES[line.kind])}>
              {LINE_MARKS[line.kind]} {line.text}
            </div>
          ))}
        </pre>
      )}
    </li>
  );
}
