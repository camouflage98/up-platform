/**
 * Motion effects ("Ken Burns" moves), defined once and consumed by BOTH renderers:
 *
 *   - the browser preview  -> effectAt() + computeDraw()  (canvas drawImage)
 *   - the MP4/AVI export   -> toFfmpegExpr()              (ffmpeg zoompan filter)
 *
 * Keeping a single definition is what makes "what you see is what you export" true.
 *
 * Each effect is three tiny arithmetic expressions over:
 *    p = progress through the clip, 0 -> 1
 *    a = strength ("amount"), e.g. 0.12 for a 12% move
 * producing:
 *    z  = zoom factor, >= 1
 *    x  = horizontal camera offset, -1 = hard left, 0 = centre, +1 = hard right
 *    y  = vertical camera offset,   -1 = top,       0 = centre, +1 = bottom
 *
 * The offsets are fractions of the *available* room at the current zoom, so a
 * pan combined with a zoom-from-1.0 starts centred and opens up naturally.
 *
 * Only `+ - * / ( ) sin cos min max abs PI` are allowed: that is the common
 * subset understood by both JavaScript and ffmpeg's expression evaluator.
 */

export const EFFECTS = {
  none: { label: 'None', z: '1', x: '0', y: '0' },

  zoomIn: { label: 'Zoom in (slow push)', z: '1+a*p', x: '0', y: '0' },
  zoomOut: { label: 'Zoom out (slow pull)', z: '1+a*(1-p)', x: '0', y: '0' },
  zoomInOut: { label: 'Zoom in, then out', z: '1+a*sin(PI*p)', x: '0', y: '0' },

  panLeft: { label: 'Slide left', z: '1+a', x: '1-2*p', y: '0' },
  panRight: { label: 'Slide right', z: '1+a', x: '-1+2*p', y: '0' },
  panUp: { label: 'Slide up', z: '1+a', x: '0', y: '1-2*p' },
  panDown: { label: 'Slide down', z: '1+a', x: '0', y: '-1+2*p' },

  zoomInLeft: { label: 'Zoom in + slide left', z: '1+a*p', x: '1-2*p', y: '0' },
  zoomInRight: { label: 'Zoom in + slide right', z: '1+a*p', x: '-1+2*p', y: '0' },
  zoomOutLeft: { label: 'Zoom out + slide left', z: '1+a*(1-p)', x: '1-2*p', y: '0' },
  zoomOutRight: { label: 'Zoom out + slide right', z: '1+a*(1-p)', x: '-1+2*p', y: '0' },
};

export const DEFAULT_EFFECT = 'zoomIn';
export const DEFAULT_AMOUNT = 0.12;

/** Names in the order the UI should list them. */
export const EFFECT_NAMES = Object.keys(EFFECTS);

export function getEffect(name) {
  return EFFECTS[name] || EFFECTS.none;
}

const compiled = new Map();
function compile(expr) {
  let fn = compiled.get(expr);
  if (!fn) {
    // Our own constant strings only - effect names from a project file are
    // looked up in EFFECTS, never evaluated directly.
    fn = new Function('p', 'a', 'sin', 'cos', 'min', 'max', 'abs', 'PI', `return (${expr});`);
    compiled.set(expr, fn);
  }
  return fn;
}

function evalExpr(expr, p, a) {
  return compile(expr)(p, a, Math.sin, Math.cos, Math.min, Math.max, Math.abs, Math.PI);
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Camera state at progress `p` (0..1) through a clip.
 * @returns {{z:number, fx:number, fy:number}}
 */
export function effectAt(name, p, amount = DEFAULT_AMOUNT) {
  const fx = getEffect(name);
  const t = clamp(p, 0, 1);
  const a = Number.isFinite(amount) ? amount : DEFAULT_AMOUNT;
  return {
    z: Math.max(1, evalExpr(fx.z, t, a)),
    fx: clamp(evalExpr(fx.x, t, a), -1, 1),
    fy: clamp(evalExpr(fx.y, t, a), -1, 1),
  };
}

/**
 * Turn an effect expression into an ffmpeg zoompan expression.
 *
 * ffmpeg counts output frames in `on`, so progress through the *whole clip* is
 * (offset + on/fps) / duration - `offset` lets us render a partial slice of a
 * clip (when a later clip overlaps it) without the motion jumping.
 */
export function toFfmpegExpr(expr, { amount = DEFAULT_AMOUNT, fps = 30, offset = 0, duration = 1 } = {}) {
  const d = duration > 0 ? duration : 1;
  const progress = `min(1,max(0,((${num(offset)}+on/${num(fps)})/${num(d)})))`;
  return expr.replace(/\bp\b/g, progress).replace(/\ba\b/g, num(amount));
}

function num(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '0';
  // ffmpeg's parser dislikes exponent notation in some builds.
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Where to draw a source image/video on a WxH canvas for a given camera state.
 * Mirrors exactly what `scale -> crop/pad -> zoompan` does during export.
 *
 * @returns {{dx:number, dy:number, dw:number, dh:number}} drawImage rectangle
 */
export function computeDraw(srcW, srcH, outW, outH, fit, z, fx, fy) {
  if (!srcW || !srcH) return { dx: 0, dy: 0, dw: outW, dh: outH };

  // 1. fit the source to the frame (cover = fill and crop, contain = letterbox)
  const s0 = fit === 'contain'
    ? Math.min(outW / srcW, outH / srcH)
    : Math.max(outW / srcW, outH / srcH);

  const baseW = srcW * s0;
  const baseH = srcH * s0;
  const baseX = (outW - baseW) / 2;
  const baseY = (outH - baseH) / 2;

  // 2. the visible window inside that fitted frame
  const ox = ((outW - outW / z) / 2) * (1 + fx);
  const oy = ((outH - outH / z) / 2) * (1 + fy);

  // 3. map the window back up to the full frame
  return {
    dx: (baseX - ox) * z,
    dy: (baseY - oy) * z,
    dw: baseW * z,
    dh: baseH * z,
  };
}
