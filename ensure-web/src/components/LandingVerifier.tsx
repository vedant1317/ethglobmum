import { useState, type FormEvent } from "react";
import { ArrowRight, Check, CircleHelp, LoaderCircle, Search, X } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { deployment } from "@/lib/config";
import { verifyProject, type Verification, type VerificationCheck } from "@/lib/verify";

const sequence = ["Resolve ENS", "Inspect resolver & authority", "Check approval / controller if configured", "Inspect manifest evidence", "Check approved commit", "Verify declared file hashes"];

export function LandingVerifier() {
  const [name, setName] = useState("");
  const [running, setRunning] = useState(false);
  const [checks, setChecks] = useState<VerificationCheck[]>([]);
  const [result, setResult] = useState<Verification>();
  const [error, setError] = useState("");
  async function run(event: FormEvent) {
    event.preventDefault();
    const input = name.trim().toLowerCase();
    setError(""); setResult(undefined); setChecks([]);
    if (![deployment.projectName, deployment.prodName].includes(input)) {
      setError(`This deployment supports ${deployment.projectName} and ${deployment.prodName}. Other projects are not configured yet.`); return;
    }
    setRunning(true);
    try {
      const verified = await verifyProject(deployment.projectName, check => setChecks(previous => [...previous.filter(item => item.id !== check.id), check]));
      setResult(verified); setChecks(verified.checks);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Verification could not be completed."); }
    finally { setRunning(false); }
  }
  return <section className="landing-section landing-verification" id="verification" aria-labelledby="landing-verify-title">
    <div className="section-intro"><p className="eyebrow">05 / INDEPENDENT VERIFICATION</p><h2 id="landing-verify-title">Don’t take the website<br /><em>at its word.</em></h2><p>Follow the records. Inspect the approval. Compare the files.<br />No wallet connection required.</p></div>
    <div className="verification-terminal">
      <div className="terminal-bar"><span><span className="terminal-dot" /> PUBLIC VERIFIER</span><span>SEPOLIA / READ ONLY</span></div>
      <form onSubmit={event => void run(event)}>
        <label htmlFor="landing-ens">The ENS name you already trust</label>
        <div className="landing-verify-input"><Search size={18} aria-hidden="true" /><input id="landing-ens" value={name} onChange={event => setName(event.target.value)} placeholder="prod.example.eth" autoComplete="off" spellCheck={false} required disabled={running} /><Button type="submit" disabled={running || !name.trim()}>{running ? <LoaderCircle className="size-4 animate-spin" /> : null}{running ? "Verifying…" : "Verify website"}<ArrowRight className="size-4" /></Button></div>
        <p className="terminal-scope">Configured project: <button type="button" disabled={running} onClick={() => setName(deployment.prodName)}>{deployment.prodName}</button><span>Live reads begin when you verify.</span></p>
      </form>
      {!running && !result && !error && <ol className="verification-sequence">{sequence.map((label, i) => <li key={label}><span>0{i + 1}</span>{label}</li>)}</ol>}
      {(running || result) && <div className="landing-verification-result" aria-busy={running}>
        <div className="verification-result-header" role="status"><span className={`result-label result-${result?.status.toLowerCase() ?? "running"}`}>{running ? "INSPECTING" : result?.status}</span><p>{running ? "Reading live evidence. Checks appear as they complete." : result?.explanation}</p></div>
        <div className="landing-checks">{checks.map(check => { const Icon = check.state === "pass" ? Check : check.state === "fail" ? X : CircleHelp; return <details key={check.id} open={check.state === "fail" || check.state === "unavailable"}><summary><Icon size={15} /><span>{check.label}</span><small>{check.state === "pass" ? "Passed" : check.state === "fail" ? "Failed" : check.state === "info" ? "Info" : "Unavailable"}</small></summary><p>{check.detail}</p></details>; })}{running && !checks.length && <p className="terminal-wait">Waiting for the first chain read…</p>}</div>
        {result && <details className="verification-comparison"><summary>Production resolver / expected vs observed</summary><dl><div><dt>Expected · configured resolver</dt><dd>{deployment.prodResolver}</dd></div><div><dt>Observed · verification snapshot</dt><dd>{result.production.resolver ?? "Not read before verification stopped."}</dd></div></dl></details>}
        {result?.blockNumber !== undefined && <p className="terminal-scope">Snapshot block <a href={`https://sepolia.etherscan.io/block/${result.blockNumber}`} target="_blank" rel="noreferrer">{result.blockNumber.toString()} ↗</a></p>}
      </div>}
      {error && <p className="terminal-error" role="alert">UNAVAILABLE — {error}</p>}
      <div className="terminal-footer"><p>{deployment.releaseController ? "Controller checks depend on the configured release version." : "Current mode: v1 owner signature. v2 controller / Safe integration pending."}</p><Link to="/verify">Full verification inspector <ArrowRight size={14} /></Link></div>
    </div>
    <div className="verification-outcomes"><p><strong>MATCH</strong> All required checks agree.</p><p><strong>MISMATCH</strong> A comparison failed.</p><p><strong>UNAVAILABLE</strong> Evidence could not be checked.</p></div>
    <p className="landing-disclaimer">Verification checks consistency with release evidence. It does not establish that the code is safe.</p>
  </section>;
}
