/**
 * The exact Node surface the build script uses.
 *
 * `vite.config.ts` runs in Node, not in the browser, and needs three things to
 * stamp the build identity into the bundle: the package version, the commit,
 * and the CI environment. Declaring precisely those rather than depending on
 * `@types/node` keeps the dependency list unchanged - this is a hotfix - while
 * leaving the config fully typechecked by `npm run build`.
 *
 * Nothing here is shipped: no application code imports it, and the declarations
 * describe the build toolchain only.
 */

declare module 'node:child_process' {
  export function execSync(
    command: string,
    options?: { stdio?: readonly ('ignore' | 'pipe' | 'inherit')[] },
  ): { toString(): string };
}

declare module 'node:fs' {
  export function readFileSync(path: URL | string, encoding: 'utf8'): string;
}

/**
 * Build-time environment.
 *
 * Only the commit references published by the common hosts are read, plus
 * `NODE_ENV`. No secret is read and none is injected into the bundle.
 */
declare const process: {
  env: {
    NODE_ENV?: string;
    /** Netlify. */
    COMMIT_REF?: string;
    /** Vercel. */
    VERCEL_GIT_COMMIT_SHA?: string;
    /** GitHub Actions. */
    GITHUB_SHA?: string;
    /** Cloudflare Pages. */
    CF_PAGES_COMMIT_SHA?: string;
  };
};
