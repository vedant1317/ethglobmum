// Gateway fetching lives in core/src/ipfs.ts (shared with the CLI verifier). Bound here to this app's gateways.
import { createIpfsFetcher } from "@ensure/core/ipfs";
import { GATEWAYS } from "./config";

export { GatewayContentMismatchError, GatewayUnavailableError, cidFromPointer } from "@ensure/core/ipfs";

const fetcher = createIpfsFetcher(GATEWAYS);
export const fetchIpfs = fetcher.fetchIpfs;
export const fetchIpfsMatching = fetcher.fetchIpfsMatching;
