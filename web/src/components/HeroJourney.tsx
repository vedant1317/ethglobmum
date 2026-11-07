import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion, useScroll, useSpring, useTransform, type MotionValue } from "framer-motion";
import { ArrowDown, ArrowRight, Pause, Play } from "lucide-react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { orbitalPoint, particlePhase, projectPoint, safeZoneOpacity, torusPoint } from "@/lib/hero-motion";

const TAU = Math.PI * 2;
const stages = ["GITHUB", "IPFS", "ENSv2", "VERIFIED"];
const details = ["An exact source commit", "Content-addressed files", "Publishing authority", "Independent evidence"];
const ease = (a: number, b: number, n: number) => { const t = Math.max(0, Math.min(1, (n - a) / (b - a))); return t * t * (3 - 2 * t); };

/** One renderer and one topology: orbit vertices become the workflow rails. */
export function HeroJourney() {
  const root = useRef<HTMLElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const elapsed = useRef(0);
  const [paused, setPaused] = useState(false);
  const [canvasFailed, setCanvasFailed] = useState(false);
  const reduced = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: root, offset: ["start start", "end end"] });
  const progress = useSpring(scrollYProgress, { stiffness: 65, damping: 28, restDelta: .0001 });
  const heroOpacity = useTransform(progress, [0, .18, .43], [1, 1, 0]);
  const heroVisibility = useTransform(progress, value => value > .43 ? "hidden" : "visible");
  const workflowVisibility = useTransform(progress, value => value < .43 ? "hidden" : "visible");
  const heroY = useTransform(progress, [0, .45], [0, -70]);
  const workflowOpacity = useTransform(progress, [.42, .67], [0, 1]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const context = element.getContext("2d", { alpha: false });
    if (!context) { setCanvasFailed(true); return; }
    let width = 1, height = 1, frame = 0, last = 0, visible = true, disposed = false;
    let pointer = { x: 0, y: 0 }, target = { x: 0, y: 0 };
    let zone = { left: 0, top: 0, right: 0, bottom: 0 };
    const measure = () => {
      const rect = element.getBoundingClientRect();
      width = rect.width; height = rect.height;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      element.width = Math.round(width * dpr); element.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (copy.current) {
        // Measure the stable layout box, independent of scroll transforms.
        const w = copy.current.offsetWidth, h = copy.current.offsetHeight;
        zone = { left: (width - w) / 2 - 18, right: (width + w) / 2 + 18, top: (height - h) / 2 - 16, bottom: (height + h) / 2 + 16 };
      }
    };
    const draw = (now: number) => {
      const delta = last ? Math.min((now - last) / 1000, .05) : 0;
      last = now;
      if (!paused && !reduced) elapsed.current += delta;
      const time = reduced ? 0 : elapsed.current;
      const p = reduced ? 0 : progress.get(), morph = ease(.17, .82, p), mobile = width < 700;
      const mask = 1 - ease(.4, .52, p);
      pointer.x += (target.x - pointer.x) * .035; pointer.y += (target.y - pointer.y) * .035;
      context.fillStyle = "#07152E"; context.fillRect(0, 0, width, height);
      const point = (u: number, v: number, orbit = -1) => {
        const world = orbit < 0 ? torusPoint(u + time * .018, v, time) : orbitalPoint(u + time * .013, orbit, time);
        const start = projectPoint(world, width, height, time, pointer.x, pointer.y);
        const fraction = u / TAU;
        const wave = Math.sin(fraction * Math.PI * 6) * (mobile ? 10 : 22) + Math.sin(v) * 8;
        const end = mobile ? { x: width * .21 + wave, y: height * (.29 + fraction * .52) } : { x: width * (.12 + fraction * .76), y: height * .52 + wave };
        return { x: start.x * (1 - morph) + end.x * morph, y: start.y * (1 - morph) + end.y * morph, depth: start.depth };
      };
      const alphaAt = (x: number, y: number) => 1 - mask * (1 - safeZoneOpacity(x, y, zone, mobile ? 48 : 100));
      const rings = mobile ? 9 : 15, segments = mobile ? 76 : 112;
      context.lineWidth = .65;
      for (let ring = 0; ring < rings + 4; ring++) {
        const orbit = ring >= rings ? ring - rings : -1;
        const v = (ring / rings) * TAU;
        let previous = point(0, v, orbit);
        for (let step = 1; step <= segments; step++) {
          const next = point(step / segments * TAU, v, orbit);
          const alpha = alphaAt((next.x + previous.x) / 2, (next.y + previous.y) / 2) * (orbit < 0 ? .15 : .28) * (1 - morph * .4);
          context.strokeStyle = `rgba(${ring % 4 === 0 ? "244,232,193" : "197,206,221"},${alpha})`;
          context.beginPath(); context.moveTo(previous.x, previous.y); context.lineTo(next.x, next.y); context.stroke();
          previous = next;
        }
      }
      // Cross sections reveal the wireframe's depth, then become short workflow connections.
      for (let section = 0; section < (mobile ? 12 : 24); section++) {
        let previous = point(section / (mobile ? 12 : 24) * TAU, 0);
        for (let j = 1; j <= 24; j++) {
          const next = point(section / (mobile ? 12 : 24) * TAU, j / 24 * TAU);
          context.strokeStyle = `rgba(197,206,221,${.11 * alphaAt(next.x, next.y) * (1 - morph * .75)})`;
          context.beginPath(); context.moveTo(previous.x, previous.y); context.lineTo(next.x, next.y); context.stroke(); previous = next;
        }
      }
      const count = mobile ? 65 : 135;
      for (let i = 0; i < count; i++) {
        const u = (particlePhase(i) + time * (.025 + (i % 4) * .003)) % TAU;
        const a = point(u, particlePhase(i + 7));
        context.fillStyle = `rgba(244,232,193,${alphaAt(a.x, a.y) * (.3 + (i % 5) * .1)})`;
        context.beginPath(); context.arc(a.x, a.y, i % 9 === 0 ? 1.8 : .9, 0, TAU); context.fill();
        if (i % 6 === 0) {
          const b = point((u + .18) % TAU, particlePhase(i + 8));
          context.strokeStyle = `rgba(197,206,221,${.12 * alphaAt(a.x, a.y)})`;
          context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke();
        }
      }
      // Anchor points belong to the same scene, never a replacement diagram.
      for (let i = 0; i < 4; i++) {
        const a = point(i / 3 * TAU, 0);
        context.strokeStyle = `rgba(244,232,193,${morph * .75})`;
        context.fillStyle = "#07152E";
        context.beginPath(); context.arc(a.x, a.y, 7, 0, TAU); context.fill(); context.stroke();
        context.fillStyle = `rgba(244,232,193,${morph})`;
        context.beginPath(); context.arc(a.x, a.y, 2, 0, TAU); context.fill();
      }
    };
    const loop = (now: number) => {
      frame = 0;
      if (disposed || !visible || document.hidden) return;
      if (now - last >= 1000 / 30) draw(now);
      if (!paused && !reduced) frame = requestAnimationFrame(loop);
    };
    const refresh = () => { if (!disposed && visible && !document.hidden) { draw(performance.now()); if (!frame && !paused && !reduced) frame = requestAnimationFrame(loop); } };
    const resize = new ResizeObserver(() => { measure(); refresh(); });
    resize.observe(element); if (copy.current) resize.observe(copy.current);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; last = 0; if (visible) refresh(); else { cancelAnimationFrame(frame); frame = 0; } });
    intersection.observe(element);
    const move = (event: PointerEvent) => { if (event.pointerType !== "mouse" || reduced || paused) return; const rect = element.getBoundingClientRect(); target = { x: (event.clientX - rect.left) / width - .5, y: (event.clientY - rect.top) / height - .5 }; };
    const leave = () => { target = { x: 0, y: 0 }; };
    const parent = element.parentElement!;
    parent.addEventListener("pointermove", move); parent.addEventListener("pointerleave", leave);
    const visibility = () => { last = 0; if (document.hidden) { cancelAnimationFrame(frame); frame = 0; } else refresh(); };
    document.addEventListener("visibilitychange", visibility);
    const unsubscribe = progress.on("change", () => { if (paused || reduced) refresh(); });
    measure(); refresh();
    return () => { disposed = true; cancelAnimationFrame(frame); resize.disconnect(); intersection.disconnect(); unsubscribe(); parent.removeEventListener("pointermove", move); parent.removeEventListener("pointerleave", leave); document.removeEventListener("visibilitychange", visibility); };
  }, [paused, reduced, progress]);

  return <section className={`hero-journey ${reduced ? "reduced-motion-journey" : ""}`} ref={root} aria-labelledby="hero-title">
    <div className="journey-sticky">
      <canvas ref={canvas} className="journey-canvas" aria-hidden="true" />
      <div className="journey-edge journey-edge-top" aria-hidden="true"><span>PROOF / AUTHORITY / CONTINUITY</span><span>ETHEREUM · SEPOLIA</span></div>
      <motion.div className="journey-hero-layer" style={{ opacity: reduced ? 1 : heroOpacity, visibility: reduced ? "visible" : heroVisibility, y: reduced ? 0 : heroY }}>
        <div className="journey-copy" ref={copy}>
          <p className="eyebrow">ENSURE / RELEASE ASSURANCE</p>
          <h1 id="hero-title">Publish with proof.<br /><em>Keep control.</em></h1>
          <p className="journey-description">From the first build to the live ENS name.<br />Know exactly what shipped, and who approved it.</p>
          <div className="journey-actions"><Button asChild size="lg"><Link to="/verify">Verify a release <ArrowRight className="size-4" /></Link></Button><Button asChild size="lg" variant="outline"><Link to="/promote">Manage publishing <ArrowRight className="size-4" /></Link></Button></div>
          <p className="journey-subnote">An accountable release. An independent check.</p>
        </div>
      </motion.div>
      <motion.div className="journey-workflow-copy" style={{ opacity: workflowOpacity, visibility: workflowVisibility }}><p className="eyebrow">One release. A connected chain of evidence.</p><h2>Nothing lost<br /><em>between the steps.</em></h2></motion.div>
      {stages.map((stage, i) => <StageLabel key={stage} index={i} progress={progress} />)}
      <motion.p className="journey-workflow-note" style={{ opacity: workflowOpacity, visibility: workflowVisibility }}>Source becomes a candidate. Owner approval makes it production.<br />Verification checks the evidence independently.</motion.p>
      {canvasFailed && <p className="journey-canvas-fallback">GitHub → IPFS → ENSv2 → Verified</p>}
      <div className="journey-bottom"><span><ArrowDown className="size-3" /> SCROLL TO FOLLOW THE RELEASE</span><button onClick={() => setPaused(!paused)} aria-pressed={paused} disabled={!!reduced}>{paused || reduced ? <Play className="size-3" /> : <Pause className="size-3" />}{reduced ? "Reduced motion" : paused ? "Resume motion" : "Pause motion"}</button></div>
    </div>
    {reduced && <div className="static-workflow"><p className="eyebrow">ONE CONNECTED CHAIN OF EVIDENCE</p><ol>{stages.map((stage, i) => <li key={stage}><span>0{i + 1} / {stage}</span><p>{details[i]}</p></li>)}</ol><p>Source becomes a candidate. Owner approval makes it production. Verification checks the evidence independently.</p></div>}
  </section>;
}

function StageLabel({ index, progress }: { index: number; progress: MotionValue<number> }) {
  const [mobile, setMobile] = useState(false);
  useEffect(() => { const media = matchMedia("(max-width: 699px)"); const update = () => setMobile(media.matches); update(); media.addEventListener("change", update); return () => media.removeEventListener("change", update); }, []);
  const initialX = [7, 78, 7, 78][index];
  const initialY = [22, 22, 76, 76][index];
  const left = useTransform(progress, [0, .17, .82], [`${initialX}%`, `${initialX}%`, `${mobile ? 34 : 12 + index * 76 / 3}%`]);
  const top = useTransform(progress, [0, .17, .82], [`${initialY}%`, `${initialY}%`, `${mobile ? 29 + index * 52 / 3 : 61}%`]);
  const opacity = useTransform(progress, [0, .18, .3, .56, .82], [.55, .55, 0, 0, 1]);
  const detailOpacity = useTransform(progress, [.6, .9], [0, 1]);
  const x = useTransform(progress, value => mobile ? (index % 2 ? -35 * (1 - ease(.17, .82, value)) : 0) : -65 * ease(.17, .82, value));
  return <motion.div className={`journey-annotation journey-annotation-${index}`} style={{ left, top, opacity, x }}><span className="annotation-leader" aria-hidden="true" /><span className="annotation-title"><small>0{index + 1} /</small> {stages[index]}</span><motion.span className="annotation-detail" style={{ opacity: detailOpacity }}>{details[index]}</motion.span></motion.div>;
}
