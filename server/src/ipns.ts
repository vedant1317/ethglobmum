// Real IPNS publishing through a Kubo node. Off unless KUBO_API_URL is set. Never for prod names.
const kubo = async (path: string) => {
  const res = await fetch(`${process.env.KUBO_API_URL}/api/v0/${path}`, { method: "POST" });
  if (!res.ok) throw new Error(`Kubo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json() as Promise<any>;
};

export async function ipnsPublish(project: { id: string }, cid: string, log: (l: string) => void): Promise<string | undefined> {
  if (!process.env.KUBO_API_URL) return undefined;
  try {
    const keyName = `ensure-${project.id}`;
    const keys = await kubo("key/list");
    const existing = keys.Keys?.find((k: any) => k.Name === keyName);
    const id = existing?.Id ?? (await kubo(`key/gen?arg=${keyName}&type=ed25519`)).Id;
    await kubo(`name/publish?arg=/ipfs/${cid}&key=${keyName}&allow-offline=true`);
    log(`IPNS: ipns://${id}`);
    return id;
  } catch (e) {
    log(`IPNS skipped: ${(e as Error).message}`);
    return undefined;
  }
}
