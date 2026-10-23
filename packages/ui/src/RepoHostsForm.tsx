import { hostKey, type RepoHost, RepoHostKind, workspaceApi } from "@trackwall/protocol";
import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage, post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { HOST_KIND_LABEL, loginCommand } from "@/lib/repo-hosts";

/** Podpowiedź hosta przy wyborze rodzaju; GitLab firmowy ma własny adres, więc bez wartości. */
const HOST_HINT: Record<RepoHostKind, string> = { gitlab: "gitlab.example.com", github: "github.com" };

/** Lista hostingów repo (ADR-19): każda zmiana zapisuje całą listę jako `repoHosts` w `workspace.yaml`. */
export function RepoHostsForm({ conn, initial }: { conn: Connection; initial: RepoHost[] }) {
  const [hosts, setHosts] = useState(initial);
  const [kind, setKind] = useState<RepoHostKind>("gitlab");
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function save(next: RepoHost[]): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      setHosts(await post(conn, workspaceApi.setRepoHosts, { repoHosts: next }));
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function add(e: FormEvent) {
    e.preventDefault();
    if (await save([...hosts, { kind, host: host.trim() }])) setHost("");
  }

  return (
    <div className="flex flex-col gap-3">
      {hosts.length > 0 && (
        <ul className="flex flex-col gap-2">
          {hosts.map((h) => (
            <li key={hostKey(h)} className="flex items-center gap-3">
              <span className="hud-label w-14 shrink-0">{HOST_KIND_LABEL[h.kind]}</span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-mono text-sm">{h.host}</span>
                <span className="text-muted-foreground truncate font-mono text-2xs">{loginCommand(h)}</span>
              </span>
              <Button
                variant="ghost"
                size="icon"
                disabled={busy}
                aria-label={`Usuń ${h.host}`}
                onClick={() => void save(hosts.filter((other) => other !== h))}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={(e) => void add(e)} className="flex gap-2">
        <span className="flex shrink-0">
          {RepoHostKind.options.map((k) => (
            <Button
              key={k}
              type="button"
              size="sm"
              variant={k === kind ? "default" : "ghost"}
              onClick={() => setKind(k)}
              aria-pressed={k === kind}
            >
              {HOST_KIND_LABEL[k]}
            </Button>
          ))}
        </span>
        <Input
          value={host}
          onChange={(e) => setHost(e.target.value)}
          placeholder={HOST_HINT[kind]}
          aria-label="Nazwa hosta, bez https://"
          className="font-mono text-xs"
        />
        <Button type="submit" size="sm" disabled={busy || host.trim() === ""}>
          Dodaj
        </Button>
      </form>
      {error && <p className="text-destructive text-xs break-words">{error}</p>}
    </div>
  );
}
