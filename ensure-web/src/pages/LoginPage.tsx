import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ArrowRight, Github, LoaderCircle, LogOut, Mail, ServerCrash } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Reveal } from "@/components/Reveal";
import { AUTH_BASE, getAuthProviders, loginUrl } from "@/lib/api";
import { useSession } from "@/lib/session";

const errorText: Record<string, string> = {
  invalid_state: "The sign-in request expired. Start again.",
  no_token: "The provider did not return an access token.",
  server_error: "The backend could not complete sign-in.",
  access_denied: "Sign-in was cancelled.",
};

const providerIcon = { github: Github, google: Mail } as const;

export function LoginPage() {
  const [params] = useSearchParams();
  const error = params.get("error");
  const session = useSession();
  const providers = useQuery({ queryKey: ["auth-providers"], queryFn: getAuthProviders, retry: false });

  return <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-[1fr_420px] lg:items-start">
    <Reveal><div>
      <p className="eyebrow">Deployment backend / sign in</p>
      <h1 className="editorial-title">Build here.<br /><em>Approve on-chain.</em></h1>
      <p className="editorial-description">Sign in to build a repository, pin it to IPFS and point an ENS name at it. Publishing to production still needs a wallet signature from the project owner.</p>
    </div></Reveal>

    <Card><CardContent className="space-y-4 pt-5 sm:pt-6">
      {error && <div role="alert" className="flex gap-3 rounded-2xl border border-foreground/30 bg-foreground/[0.06] p-4 text-sm"><AlertCircle className="mt-0.5 size-4 shrink-0" /><span>{errorText[error] ?? `Sign-in failed: ${error}`}</span></div>}

      {session.signedIn && session.user ? <div className="space-y-4">
        <div className="flex items-center gap-3">
          {session.user.avatar && <img src={session.user.avatar} alt="" className="size-10 rounded-full" />}
          <div className="min-w-0"><div className="truncate text-sm font-medium">{session.user.name || session.user.login}</div><div className="truncate text-xs text-muted-foreground">Signed in with {session.user.provider}</div></div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild><Link to="/deploy">Deploy a site <ArrowRight className="size-4" /></Link></Button>
          <Button variant="ghost" onClick={() => void session.signOut()}><LogOut className="size-4" /> Sign out</Button>
        </div>
      </div> : providers.isLoading || session.isLoading ? <div role="status" className="flex items-center gap-3 py-6 text-sm text-muted-foreground"><LoaderCircle className="size-4 animate-spin" /> Contacting the backend…</div>
      : providers.error ? <div role="alert" className="space-y-3 py-2">
        <div className="flex items-center gap-2 text-sm font-medium"><ServerCrash className="size-4" /> Backend unavailable</div>
        <p className="text-sm leading-6 text-muted-foreground">{providers.error instanceof Error ? providers.error.message : "Request failed"} Start it with <code className="font-mono text-xs">npm --prefix backend run dev</code> or set <code className="font-mono text-xs">VITE_API_URL</code>.</p>
        <Button variant="secondary" size="sm" onClick={() => void providers.refetch()}>Try again</Button>
      </div>
      : <div className="space-y-3">
        <p className="eyebrow">Choose a provider</p>
        {providers.data?.providers.map((provider) => {
          const Icon = providerIcon[provider.id as keyof typeof providerIcon] ?? ArrowRight;
          return <div key={provider.id}>
            {provider.available
              ? <Button asChild variant={provider.id === "github" ? "default" : "secondary"} className="w-full justify-start"><a href={loginUrl(provider.id)}><Icon className="size-4" /> Continue with {provider.name}</a></Button>
              : <Button variant="outline" className="w-full justify-start" disabled><Icon className="size-4" /> {provider.name} is not configured</Button>}
            <p className="mt-1.5 px-1 text-xs leading-5 text-muted-foreground">{provider.available ? provider.note : `Set ${provider.id.toUpperCase()}_CLIENT_ID and _SECRET in backend/.env.`}</p>
          </div>;
        })}
      </div>}
      <p className="border-t border-foreground/[0.07] pt-4 font-mono text-[10px] text-muted-foreground">Backend · {AUTH_BASE}</p>
    </CardContent></Card>
  </div>;
}
