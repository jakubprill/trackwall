import type { DoctorCheck } from "@trackwall/protocol";
import { getStartedPlan } from "@/lib/get-started";
import { GetStartedSteps } from "@/views/settings/GetStartedSteps";
import type { GalleryState } from "./gallery-state.ts";

const ok = (id: DoctorCheck["id"], summary: string): DoctorCheck => ({ id, status: "ok", summary, fix: null });

/** The steps of "Get started" for the doctor's `checks`, in a column as Settings lays them out. */
function StepsOf({ checks }: { checks: DoctorCheck[] }) {
  return (
    <div className="flex flex-col gap-4">
      <GetStartedSteps plan={getStartedPlan({ checkedAt: "2026-11-17T16:00:00.000Z", checks })} />
    </div>
  );
}

const LONG_FOLDER = "C:\\Users\\alexandra.featherstonehaugh\\source\\repos\\customer-notification-preferences";

const NOT_TRUSTED: DoctorCheck = {
  id: "copilot-trusted-folder",
  status: "warn",
  summary: "Copilot CLI does not trust the projects folder; it asks before working in each repo.",
  fix: `Add ${LONG_FOLDER} to "trustedFolders" in C:\\Users\\alexandra.featherstonehaugh\\.copilot\\config.json, so Copilot CLI stops asking for every repo and task.`,
};

const newComputer: GalleryState = {
  name: "A new computer",
  render: () => (
    <StepsOf
      checks={[
        {
          id: "projects-folder",
          status: "fail",
          summary: "No projects folder is set.",
          fix: 'Choose the folder with your repos in "Settings > Workspace".',
        },
        ok("git", "git 2.47.1"),
        {
          id: "copilot-cli",
          status: "fail",
          summary: "Copilot CLI (copilot) not found in PATH.",
          fix: "Install GitHub Copilot CLI, sign in by running `copilot` once, and restart Trackwall.",
        },
        ok("network", "github.com and api.githubcopilot.com answer."),
        {
          id: "mise",
          status: "warn",
          summary: "mise: program mise not found in PATH",
          fix: "Install mise (mise.jdx.dev) and restart Trackwall; repo tasks, services and task verification need it.",
        },
      ]}
    />
  ),
};

const companyNetwork: GalleryState = {
  name: "In a container behind a company proxy",
  render: () => (
    <StepsOf
      checks={[
        ok("projects-folder", "/workspaces"),
        ok("git", "git 2.47.1"),
        {
          id: "git-remotes",
          status: "fail",
          summary: "git cannot reach gitlab.example.com: no sign-in for HTTPS.",
          fix: "Run `glab auth login --hostname gitlab.example.com` in the projects folder's Shell and let it set up git.",
        },
        ok("copilot-cli", "Copilot CLI 1.0.110"),
        ok("copilot-trusted-folder", "Copilot CLI trusts /workspaces."),
        {
          id: "network",
          status: "fail",
          summary: "The proxy proxy.example.com:8080 replaces certificates, and Copilot CLI does not trust its certificate.",
          fix: "Set NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/corp-root.crt in the container's environment, then restart Trackwall.",
        },
        {
          id: "copilot-sandbox",
          status: "warn",
          summary: "Copilot CLI's sandbox is off in this container, so tasks without approvals run with the container's full access.",
          fix: 'Give the container the sandbox, or choose "No task" in Settings › Agents › Sandbox.',
        },
        ok("mise", "mise 2026.11.2"),
        {
          id: "gitlab-cli",
          status: "fail",
          summary: "glab is not signed in to gitlab.example.com",
          fix: "Run `glab auth login --hostname gitlab.example.com` in a terminal.",
        },
      ]}
    />
  ),
};

const recommendedLeft: GalleryState = {
  name: "Only a recommended step left, with long paths",
  render: () => (
    <StepsOf
      checks={[
        ok("projects-folder", LONG_FOLDER),
        ok("git", "git 2.47.1.windows.2 at C:\\Users\\alexandra.featherstonehaugh\\Dev\\tools\\mingit\\cmd\\git.exe"),
        ok("copilot-cli", "Copilot CLI 1.0.110"),
        NOT_TRUSTED,
        ok("network", "github.com and api.githubcopilot.com answer through the proxy proxy.example.com:8080."),
        ok("mise", "mise 2026.11.2"),
      ]}
    />
  ),
};

const ready: GalleryState = {
  name: "Everything done",
  render: () => (
    <StepsOf
      checks={[
        ok("projects-folder", "/home/me/dev"),
        ok("git", "git 2.47.1"),
        ok("git-remotes", "git reaches gitlab.example.com."),
        ok("copilot-cli", "Copilot CLI 1.0.110"),
        ok("copilot-trusted-folder", "Copilot CLI trusts /home/me/dev."),
        ok("network", "github.com and api.githubcopilot.com answer."),
        ok("mise", "mise 2026.11.2"),
        ok("gitlab-cli", "glab is signed in to gitlab.example.com."),
      ]}
    />
  ),
};

export const GET_STARTED_STATES: readonly GalleryState[] = [newComputer, companyNetwork, recommendedLeft, ready];
