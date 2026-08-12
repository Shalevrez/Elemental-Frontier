/**
 * The running build's identity.
 *
 * Injected by Vite's `define` at compile time, so these values live inside the
 * same JavaScript bundle they describe. That is the whole point: after a
 * deploy, the label in the corner has to be able to answer "is the new build
 * actually live?", and a version read from a separately cached file could
 * disagree with the code that read it.
 *
 * Nothing here makes a network request, and nothing but the four declared
 * values is exposed.
 */

declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;
declare const __APP_BUILT__: string;
declare const __APP_MODE__: string;

/** Falls back rather than throwing when the bundle was built without define. */
function injected(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

export interface BuildInfo {
  /** Semantic version, from package.json. */
  version: string;
  /** Short commit reference, or `dev` for a local build. */
  commit: string;
  /** UTC build timestamp, `YYYY-MM-DD HH:MM`. */
  built: string;
  /** `production` or `development`. */
  mode: string;
}

export const BUILD: BuildInfo = Object.freeze({
  version: injected(typeof __APP_VERSION__ === 'undefined' ? undefined : __APP_VERSION__, '0.0.0'),
  commit: injected(typeof __APP_COMMIT__ === 'undefined' ? undefined : __APP_COMMIT__, 'dev'),
  built: injected(typeof __APP_BUILT__ === 'undefined' ? undefined : __APP_BUILT__, 'unknown'),
  mode: injected(typeof __APP_MODE__ === 'undefined' ? undefined : __APP_MODE__, 'development'),
});

/**
 * The short label shown on screen, e.g. `v1.0.1 • a1b2c3d`.
 *
 * A local build reads `v1.0.1 • dev`, which is a useful thing to see rather
 * than a failure - it says plainly that this is not a deployed bundle.
 */
export function versionLabel(info: BuildInfo = BUILD): string {
  return `v${info.version} • ${info.commit}`;
}

/** The longer form, for the tooltip and the accessible label. */
export function versionDetail(info: BuildInfo = BUILD): string {
  return `Built ${info.built} UTC • ${info.mode}`;
}

/** True when this bundle was produced by a real deployment build. */
export function isProductionBuild(info: BuildInfo = BUILD): boolean {
  return info.mode === 'production' && info.commit !== 'dev';
}
