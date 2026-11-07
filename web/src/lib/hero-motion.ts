export type Point3 = { x: number; y: number; z: number };
export type ScreenPoint = { x: number; y: number; depth: number };
export type SafeZone = { left: number; top: number; right: number; bottom: number };
const TAU = Math.PI * 2;

/** No geometry is visible inside the measured headline, copy, and CTA bounds. */
export function safeZoneOpacity(x: number, y: number, zone: SafeZone, feather = 90): number {
  const dx = Math.max(zone.left - x, 0, x - zone.right);
  const dy = Math.max(zone.top - y, 0, y - zone.bottom);
  const t = Math.min(1, Math.hypot(dx, dy) / Math.max(1, feather));
  return t * t * (3 - 2 * t);
}

/** Slow periodic deformation changes the surface itself, not just its orientation. */
export function torusPoint(u: number, v: number, time: number): Point3 {
  const major = 1 + .075 * Math.sin(u * 3 + time * .13) + .035 * Math.cos(u * 5 - time * .09);
  const tube = .23 + .035 * Math.sin(u * 2 - v * 3 + time * .17);
  const twist = v + .23 * Math.sin(u * 2 + time * .1);
  const radius = major + tube * Math.cos(twist);
  return {
    x: radius * Math.cos(u),
    y: radius * Math.sin(u),
    z: tube * Math.sin(twist) + .075 * Math.sin(u * 4 + time * .11),
  };
}

export function orbitalPoint(angle: number, orbit: number, time: number): Point3 {
  const radius = 1.12 + orbit * .075 + .035 * Math.sin(angle * 3 + time * .08 + orbit);
  const tilt = .28 + orbit * .22;
  const y = radius * Math.sin(angle);
  return {
    x: radius * Math.cos(angle),
    y: y * Math.cos(tilt),
    z: y * Math.sin(tilt) + .055 * Math.sin(angle * 2 - time * .12),
  };
}

export function projectPoint(point: Point3, width: number, height: number, time: number, pointerX = 0, pointerY = 0): ScreenPoint {
  const yaw = .15 * Math.sin(time * .035) + time * .012 + pointerX * .055;
  const tilt = .71 + .14 * Math.sin(time * .045) + pointerY * .045;
  const x = point.x * Math.cos(yaw) - point.z * Math.sin(yaw);
  const z = point.x * Math.sin(yaw) + point.z * Math.cos(yaw);
  const y = point.y * Math.cos(tilt) - z * Math.sin(tilt);
  const depth = point.y * Math.sin(tilt) + z * Math.cos(tilt);
  const scale = Math.min(width * .48, height * .8);
  const perspective = 4.5 / (4.5 + depth);
  return { x: width / 2 + x * scale * perspective, y: height / 2 + y * scale * perspective, depth };
}

/** Deterministic phases keep the particle field structured on the orbital paths. */
export function particlePhase(index: number): number {
  return ((index * .61803398875) % 1) * TAU;
}
