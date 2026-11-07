import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, GitBranch, Globe, LoaderCircle, Rocket, ServerCrash, Unplug } from "lucide-react";
import { Link } from "react-router-dom";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SectionHeading } from "@/components/SectionHeading";
import { API_BASE, disconnectRepo, getConnectedRepos, getSites, type ConnectedRepo } from "@/lib/api";
import { useSession } from "@/lib/session";

/** Backend deploy overview: every domain in DeployRegistry plus the user's push-connected repos. */
export function SitesPage() {
  const session = useSession();
  const sites = useQuery({ queryKey: ["sites"], queryFn: getSites, refetchInterval: 60_000 });
  const connected = useQuery({ queryKey: ["gh-connected"], queryFn: getConnectedRepos, enabled: Boolean(session.me?.canManageRepos) });
  const domains = sites.data?.domains ?? [];

  return <div>
    <SectionHeading eyebrow="Deployment backend / Sepolia registry" title="Sites" description="Every domain the backend has logged in its on-chain DeployRegistry. Open one for its deploy history and IPNS pointer."
      action={<Button asChild><Link to="/deploy"><Rocket className="size-4" /> New deploy</Link></Button>} />

    <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
      <Card><CardHeader className="flex-row items-center justify-between"><CardTitle>Deployed domains</CardTitle>{sites.isFetching && <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label="Refreshing" />}</CardHeader><CardContent>
        {sites.isLoading ? <p role="status" className="text-sm text-muted-foreground">Reading the registry…</p>
          : sites.error ? <div role="alert" className="space-y-3"><p className="flex items-center gap-2 text-sm font-medium"><ServerCrash className="size-4" /> Sites could not be loaded</p><p className="text-sm leading-6 text-muted-foreground">{(sites.error as Error).message}</p><p className="font-mono text-[10px] text-muted-foreground">{API_BASE}</p><Button size="sm" variant="secondary" onClick={() => void sites.refetch()}>Try again</Button></div>
          : domains.length ? <ul className="divide-y divide-foreground/[0.07]">{domains.map((domain) => <li key={domain}>
            <Link to={`/sites/${encodeURIComponent(domain)}`} className="flex items-center gap-3 rounded-xl px-2 py-3 text-sm hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
              <Globe className="size-4 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1 truncate font-mono text-xs">{domain}</span><ArrowUpRight className="size-4 text-muted-foreground" />
            </Link></li>)}</ul>
          : <p className="text-sm text-muted-foreground">No deploys recorded yet.</p>}
      </CardContent></Card>

      <Card><CardHeader><CardTitle>Deploy on push</CardTitle></CardHeader><CardContent>
        {!session.signedIn ? <p className="text-sm leading-6 text-muted-foreground"><Link to="/login" className="underline underline-offset-4">Sign in with GitHub</Link> to see repositories that redeploy on every push.</p>
          : !session.me?.canManageRepos ? <p className="text-sm leading-6 text-muted-foreground">Repository webhooks need a GitHub sign-in.</p>
          : connected.isLoading ? <p role="status" className="text-sm text-muted-foreground">Loading…</p>
          : connected.data?.repos.length ? <ul className="space-y-3">{connected.data.repos.map((repo) => <ConnectedRow key={`${repo.repoFullName}:${repo.branch}`} repo={repo} />)}</ul>
          : <p className="text-sm leading-6 text-muted-foreground">None yet. Tick “Redeploy on every push” when you deploy a repository.</p>}
      </CardContent></Card>
    </div>
  </div>;
}

function ConnectedRow({ repo }: { repo: ConnectedRepo }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () => disconnectRepo(repo.owner, repo.repo, repo.branch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["gh-connected"] }),
  });
  return <li className="rounded-2xl border border-foreground/[0.07] p-3">
    <div className="flex items-start gap-3">
      <GitBranch className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{repo.repoFullName}</div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>{repo.branch}</span><span>→</span><Link className="font-mono hover:text-foreground" to={`/sites/${encodeURIComponent(repo.domain)}`}>{repo.domain}</Link><Badge variant="neutral">{repo.env}</Badge>{!repo.webhookId && <Badge variant="warning">no webhook</Badge>}</div>
      </div>
      <Button size="icon" variant="ghost" aria-label={`Stop deploying ${repo.repoFullName} on push`} disabled={remove.isPending} onClick={() => remove.mutate()}>{remove.isPending ? <LoaderCircle className="size-4 animate-spin" /> : <Unplug className="size-4" />}</Button>
    </div>
    {remove.error && <p role="alert" className="mt-2 text-xs">{(remove.error as Error).message}</p>}
  </li>;
}
