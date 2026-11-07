// Types shared by the server and every client, so they can't drift.
export type NameMode = "quick" | "custom";
export type DeployStatus = "queued" | "running" | "live" | "preview" | "built" | "superseded" | "failed";

export type Receipt = {
  commitSha: string;
  repositoryId: string;
  siteCid: string;
  manifestCid: string;
  manifestDigest: string;
  commitDigest: string;
  contenthash: string;
  name: string;
  txHash: string;
  logTxHash?: string;
  ipns?: string;
  prodWriteBlocked?: boolean;
  url: string;
};

export type Deploy = {
  id: string;
  projectId: string;
  commitSha: string | null;
  status: DeployStatus;
  dryRun: boolean;
  error: string | null;
  receipt: Receipt | null;
  createdAt: string;
};

export type Project = {
  id: string;
  repoUrl: string;
  branch: string;
  subfolder: string;
  outputDir: string | null;
  mode: NameMode;
  name: string;
  previewName: string | null;
};

export type DeployEvent =
  | { event: "log"; data: { line: string } }
  | { event: "stage"; data: { stage: string } }
  | { event: "done"; data: Deploy }
  | { event: "error"; data: { message: string } }
  | { event: "heartbeat"; data: Record<string, never> };

export const DEPLOY_ENVS = ["production", "staging", "preview"] as const;
