import type { DoctorCheck } from "@trackwall/protocol";
import { GetStartedSteps, TrustFolderStep } from "@/components/GetStartedSteps";
import { type GetStartedStep, getStartedPlan, TRUST_FOLDER_STEP } from "@/lib/get-started";
import { GetStartedCard } from "@/views/sessions/GetStartedCard";
import type { GalleryState } from "./gallery-state.ts";

const ok = (id: DoctorCheck["id"], summary: string): DoctorCheck => ({ id, status: "ok", summary, fix: null });

/** A click in the gallery sends nothing: the button stays as it is while it waits. */
const NEVER_ANSWERS = () => new Promise<never>(() => {});

const plan = (checks: DoctorCheck[]) => getStartedPlan({ checkedAt: "2026-11-17T16:00:00.000Z", checks });

/** "Trust folder" where the trusted folder step is open; the gallery draws no form of the projects folder, which reads. */
const action = (step: GetStartedStep) =>
  step.id === TRUST_FOLDER_STEP && step.state === "todo" ? <TrustFolderStep fix={step.fix} trust={NEVER_ANSWERS} /> : null;

/** The steps of "Get started" for the doctor's `checks`, in a column as Settings lays them out. */
function StepsOf({ checks }: { checks: DoctorCheck[] }) {
  return (
    <div className="flex flex-col gap-4">
      <GetStartedSteps plan={plan(checks)} action={action} />
    </div>
  );
}

/** The same steps as the card above the Sessions view's form shows them (ADR-289); without `checks`, while the doctor runs. */
function CardOf({ checks, place = "on this computer" }: { checks?: DoctorCheck[]; place?: string }) {
  return (
    <GetStartedCard
      plan={checks && plan(checks)}
      error={undefined}
      place={place}
      action={action}
      onCheckAgain={() => {}}
      onOpenGetStarted={() => {}}
    />
  );
}

const LONG_FOLDER = "C:\\Users\\alexandra.featherstonehaugh\\source\\repos\\customer-notification-preferences";

const NOT_TRUSTED: DoctorCheck = {
  id: "copilot-trusted-folder",
  status: "warn",
  summary: "Copilot CLI does not trust the projects folder; it asks before working in each repo.",
  fix: `Add ${LONG_FOLDER} to "trustedFolders" in C:\\Users\\alexandra.featherstonehaugh\\.copilot\\config.json, so Copilot CLI stops asking for every repo and task.`,
};

const NEW_COMPUTER: DoctorCheck[] = [
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
];

const newComputer: GalleryState = { name: "A new computer", render: () => <StepsOf checks={NEW_COMPUTER} /> };

const COMPANY_NETWORK: DoctorCheck[] = [
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
];

const companyNetwork: GalleryState = { name: "In a container behind a company proxy", render: () => <StepsOf checks={COMPANY_NETWORK} /> };

const RECOMMENDED_LEFT: DoctorCheck[] = [
  ok("projects-folder", LONG_FOLDER),
  ok("git", "git 2.47.1.windows.2 at C:\\Users\\alexandra.featherstonehaugh\\Dev\\tools\\mingit\\cmd\\git.exe"),
  ok("copilot-cli", "Copilot CLI 1.0.110"),
  NOT_TRUSTED,
  ok("network", "github.com and api.githubcopilot.com answer through the proxy proxy.example.com:8080."),
  ok("mise", "mise 2026.11.2"),
];

const recommendedLeft: GalleryState = {
  name: "Only a recommended step left, with long paths",
  render: () => <StepsOf checks={RECOMMENDED_LEFT} />,
};

const READY: DoctorCheck[] = [
  ok("projects-folder", "/home/me/dev"),
  ok("git", "git 2.47.1"),
  ok("git-remotes", "git reaches gitlab.example.com."),
  ok("copilot-cli", "Copilot CLI 1.0.110"),
  ok("copilot-trusted-folder", "Copilot CLI trusts /home/me/dev."),
  ok("network", "github.com and api.githubcopilot.com answer."),
  ok("mise", "mise 2026.11.2"),
  ok("gitlab-cli", "glab is signed in to gitlab.example.com."),
];

const ready: GalleryState = { name: "Everything done", render: () => <StepsOf checks={READY} /> };

export const GET_STARTED_STATES: readonly GalleryState[] = [newComputer, companyNetwork, recommendedLeft, ready];

export const GET_STARTED_CARD_STATES: readonly GalleryState[] = [
  { name: "While the doctor runs", render: () => <CardOf /> },
  { name: "A new computer", render: () => <CardOf checks={NEW_COMPUTER} /> },
  { name: "In a container behind a company proxy", render: () => <CardOf checks={COMPANY_NETWORK} place="in a container" /> },
  { name: "Only a recommended step left, with long paths", render: () => <CardOf checks={RECOMMENDED_LEFT} /> },
  { name: "Everything done", render: () => <CardOf checks={READY} /> },
];
