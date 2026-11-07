import { useId } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ArrowUpRight, FileCode2, Fingerprint, GitBranch, Globe2 } from "lucide-react";
import { Link } from "react-router-dom";
import { deployment } from "@/lib/config";

// A projected torus represents the same immutable artifact seen from many angles.
function meshPath(fixed: number, meridian: boolean) {
  const points = Array.from({ length: 97 }, (_, i) => {
    const t = i / 96 * Math.PI * 2;
    const u = meridian ? fixed : t;
    const v = meridian ? t : fixed;
    const radius = 87 + 31 * Math.cos(v);
    const x = radius * Math.cos(u);
    const y = radius * Math.sin(u);
    const z = 31 * Math.sin(v);
    const tilt = .93;
    const py = y * Math.cos(tilt) - z * Math.sin(tilt);
    // Orthographic projection keeps the torus symmetric about its local origin.
    // The parent SVG group provides the single, fixed diagram center.
    return `${i ? "L" : "M"}${x.toFixed(2)},${py.toFixed(2)}`;
  });
  return points.join(" ") + " Z";
}
const mesh = [
  ...Array.from({ length: 28 }, (_, i) => meshPath(i / 28 * Math.PI * 2, true)),
  ...Array.from({ length: 17 }, (_, i) => meshPath(i / 17 * Math.PI * 2, false)),
];

export function ReleaseFlow({ paused = false }: { paused?: boolean }) {
  const reduceMotion = useReducedMotion();
  const still = paused || reduceMotion;
  const plaqueGradient = useId();
  return <figure className="release-engine" aria-label="Release model: build the preview, hash the files, obtain the owner's signature, then publish to the production ENS name.">
    <div className="engine-canvas">
      <svg className="engine-drawing" viewBox="0 0 600 470" fill="none" aria-hidden="true">
        <path d="M300 50V420M65 235H540" stroke="currentColor" strokeOpacity=".09" />
        <circle cx="300" cy="235" r="144" stroke="currentColor" strokeOpacity=".09" strokeDasharray="2 6" />
        <g transform="translate(300 235)">
          <motion.g style={{ originX: .5, originY: .5 }} animate={{ rotate: still ? 0 : 360 }} transition={still ? { duration: .3 } : { duration: 42, repeat: Infinity, ease: "linear" }}>
            {mesh.map((d, i) => <path key={i} d={d} stroke="currentColor" strokeWidth={i < 28 ? .75 : .45} strokeOpacity={i < 28 ? .7 : .4} />)}
          </motion.g>
        </g>
        <path d="M140 110H184L218 168M183 353L221 301M388 166L435 111M399 299L438 362H493" stroke="currentColor" strokeOpacity=".15" />
        <motion.path d="M140 110H184L218 168M183 353L221 301M388 166L435 111M399 299L438 362H493" stroke="currentColor" strokeWidth="1.1" strokeDasharray="3 12" animate={{ strokeDashoffset: still ? 0 : [0, -60] }} transition={still ? { duration: 0 } : { duration: 5, repeat: Infinity, ease: "linear" }} />
        <circle cx="300" cy="235" r="24" fill="var(--diagram-paper)" stroke="currentColor" strokeOpacity=".15" />
        <text x="300" y="239" textAnchor="middle" fill="var(--diagram-ink)" stroke="none" fontSize="10" letterSpacing="1.3">IPFS</text>
      </svg>
      <Link to="/promote" className="engine-build" aria-label={`Review the build candidate ${deployment.previewName}`}>
        <span className="engine-build-header"><GitBranch className="size-3.5" aria-hidden="true" /><span>BUILD CANDIDATE</span><ArrowUpRight className="ml-auto size-3" aria-hidden="true" /></span>
        <span className="document-lines" aria-hidden="true">{[.85, .62, .72].map((width, i) => <motion.span key={i} style={{ width: `${width * 100}%`, transformOrigin: "left" }} animate={{ scaleX: still ? 1 : [1, .5 + i * .08, 1] }} transition={still ? { duration: .3 } : { duration: 3.8 + i * .9, repeat: Infinity, ease: "easeInOut" }} />)}</span>
        <span className="engine-node-detail">{deployment.previewName}</span>
      </Link>
      <motion.div className="engine-hash" animate={still ? { x: 0, y: 0, rotate: 0 } : { x: [-2, 3, 1, -2], y: [1, -3, 3, 1], rotate: [-7, 8, -3, -7] }} transition={still ? { duration: .3 } : { duration: 14, repeat: Infinity, ease: "easeInOut" }}>
        <Link to="/verify" className="hash-hexagon" aria-label="Verify the manifest and SHA-256 file hashes"><svg viewBox="0 0 120 134" fill="none" aria-hidden="true"><path d="M60 1 119 34v66l-59 33L1 100V34Z" fill="var(--diagram-accent)" stroke="var(--diagram-line)" /><path d="M60 8 113 38v58l-53 30L7 96V38Z" stroke="var(--diagram-highlight)" /></svg><span><FileCode2 className="size-5" strokeWidth={1.3} aria-hidden="true" /><strong>SHA-256</strong><small>FILE MANIFEST</small></span></Link>
      </motion.div>
      <Link to="/promote" className="engine-approval" aria-label="Review the EIP-712 owner signature">
        <span className="signature-dial"><motion.svg viewBox="0 0 110 110" fill="none" aria-hidden="true" animate={{ rotate: still ? 0 : -360 }} transition={still ? { duration: .3 } : { duration: 25, repeat: Infinity, ease: "linear" }}><circle cx="55" cy="55" r="51" stroke="var(--diagram-line)" strokeDasharray="1 5" /><path d="M55 4a51 51 0 0 1 51 51" stroke="var(--diagram-ink)" strokeWidth="2" /></motion.svg><Fingerprint strokeWidth={1.15} aria-hidden="true" /></span>
        <span className="engine-node-label">OWNER SIGNATURE</span><span className="engine-node-detail">EIP-712 approval</span>
      </Link>
      <div className="engine-resolver-track">
        <motion.div animate={still ? { x: 0, y: 0, rotate: 0 } : { x: [0, 3, -2, 0], y: [2, -3, -1, 2], rotate: [-1.5, 2.5, -2, -1.5] }} transition={still ? { duration: .3 } : { duration: 11, repeat: Infinity, ease: "easeInOut" }}>
          <Link to="/verify" className="engine-resolver" aria-label={`Verify production ${deployment.prodName}`}>
            <svg className="resolver-plaque-shape" viewBox="0 0 240 100" fill="none" aria-hidden="true">
              <defs><linearGradient id={plaqueGradient} x1="20" y1="0" x2="220" y2="100" gradientUnits="userSpaceOnUse"><stop stopColor="#fff3dc" /><stop offset="1" stopColor="#d8c49e" /></linearGradient></defs>
              <path d="M21 1H219L239 21V79L219 99H21L1 79V21Z" fill={`url(#${plaqueGradient})`} stroke="#fff2d7" strokeWidth="1.5" />
              <path d="M24 7H216L233 24V76L216 93H24L7 76V24Z" stroke="#fff8e8" strokeOpacity=".7" />
              <path d="M8 76 24 92H216L232 76" stroke="#b8a27d" strokeOpacity=".4" strokeWidth="2" />
            </svg>
            <Globe2 className="size-4" strokeWidth={1.4} aria-hidden="true" /><span>{deployment.prodName}</span><ArrowUpRight className="size-3.5" aria-hidden="true" />
          </Link>
        </motion.div>
        <span className="engine-node-label">PRODUCTION ENS NAME</span>
      </div>
    </div>
    <figcaption className="engine-caption"><span>01 BUILD</span><span>02 HASH</span><span>03 APPROVE</span><span>04 PUBLISH</span></figcaption>
  </figure>;
}
