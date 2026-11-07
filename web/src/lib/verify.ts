// The verifier itself lives in core/src/verify.ts and is shared with `ensure verify` (CLI) and ensure-web/.
// This file only binds it to this app's Sepolia client, address book and IPFS gateways.
import { createVerifier, type VerifierClient } from "@ensure/core/verify";
import { GATEWAYS, deployment, publicClient } from "./config";

export type { BuildCheck, CheckState, EnvironmentSummary, Verification, VerificationCheck, VerifyStatus } from "@ensure/core/verify";

const verifier = createVerifier({ client: publicClient as unknown as VerifierClient, deployment, gateways: GATEWAYS });

export const { verifyProject, verifyUnprotectedName, verifyBuildManifestFiles, readCurrentProjectOwner } = verifier;
export const verifyName = verifyProject;
