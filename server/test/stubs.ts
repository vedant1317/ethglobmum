// Stand-ins for services needing credentials: Pinata, public gateways and GitHub's API.
// Everything else in the e2e test is real.
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

const cidOf = (codec: number, data: Uint8Array | string) =>
  CID.createV1(codec, Digest.create(0x12, createHash("sha256").update(data).digest())).toString();

export type Repo = { id: number; private: boolean; default_branch: string; collaborators?: string[] };

export function startStubs(port: number, opts: { privatePinJwt: string }) {
  const content = new Map<string, Buffer>();
  const repos = new Map<string, Repo>();
  const calls: string[] = [];
  const pinataNetworks: string[] = [];
  const kuboKeys = new Map<string, string>();
  const ipnsPublished: string[] = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, `http://localhost:${port}`);
    const path = url.pathname;
    calls.push(`${req.method} ${path}`);
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const json = (o: unknown, code = 200) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    const auth = req.headers.authorization ?? "";

    if (path === "/pinning/pinFileToIPFS" || path === "/v3/files") {
      if (auth !== `Bearer ${opts.privatePinJwt}`) return json({ error: "bad jwt" }, 401);
      const form = await new Request(url, { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body }).formData();
      const files = form.getAll("file") as File[];
      if (path === "/v3/files") {
        pinataNetworks.push(String(form.get("network")));
        if (files.length !== 1) return json({ error: "v3 takes one file" }, 400);
        const bytes = Buffer.from(await files[0].arrayBuffer());
        const cid = cidOf(0x55, bytes);
        content.set(cid, bytes);
        return json({ data: { id: "x", cid, network: form.get("network") } });
      }
      const entries: [string, Buffer][] = [];
      for (const f of files) entries.push([f.name.replace(/^release\//, ""), Buffer.from(await f.arrayBuffer())]);
      entries.sort(([a], [b]) => (a < b ? -1 : 1));
      const cid = cidOf(0x70, entries.map(([p, b]) => `${p}:${createHash("sha256").update(b).digest("hex")}`).join("\n"));
      for (const [p, b] of entries) content.set(`${cid}/${p}`, b);
      return json({ IpfsHash: cid, PinSize: 1, Timestamp: "now", isDuplicate: false });
    }
    if (path.startsWith("/ipfs/")) {
      const hit = content.get(path.slice(6));
      if (!hit) { res.writeHead(404); return res.end("not found"); }
      res.writeHead(200);
      return res.end(hit);
    }
    if (path === "/api/v0/key/list") return json({ Keys: [...kuboKeys].map(([Name, Id]) => ({ Name, Id })) });
    if (path === "/api/v0/key/gen") { const Id = `k51${kuboKeys.size}`; kuboKeys.set(url.searchParams.get("arg")!, Id); return json({ Name: url.searchParams.get("arg"), Id }); }
    if (path === "/api/v0/name/publish") { ipnsPublished.push(`${url.searchParams.get("key")}->${url.searchParams.get("arg")}`); return json({ Name: "x", Value: url.searchParams.get("arg") }); }
    if (path === "/login/oauth/access_token") return json({ access_token: "user-token-1" });
    if (path === "/user") return auth === "Bearer user-token-1" ? json({ id: 42, login: "alice", email: "a@example.com" }) : json({}, 401);
    if (path === "/user/repos") return json([...repos].map(([n, r]) => ({ id: r.id, full_name: n, private: r.private, default_branch: r.default_branch })));
    if (path.endsWith("/installation")) return auth.startsWith("Bearer ey") ? json({ id: 7 }) : json({}, 401);
    if (path === "/app/installations/7/access_tokens") return json({ token: "ghs_shortlived" });
    const m = path.match(/^\/repos\/([^/]+\/[^/]+)(\/branches)?$/);
    if (m) {
      const r = repos.get(m[1]);
      if (!r || (r.private && auth !== "Bearer user-token-1")) return json({ message: "Not Found" }, 404);
      return m[2] ? json([{ name: "main" }, { name: "dev" }]) : json(r);
    }
    json({ error: `no stub for ${path}` }, 500);
  });
  return new Promise<{ content: typeof content; repos: typeof repos; calls: string[]; pinataNetworks: string[]; ipnsPublished: string[]; close: () => void }>((ok) =>
    server.listen(port, () => ok({ content, repos, calls, pinataNetworks, ipnsPublished, close: () => server.close() })));
}
