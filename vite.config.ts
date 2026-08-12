import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

/**
 * Build identity, injected into the bundle at compile time.
 *
 * The point of this is deployment verification: after a deploy, the label in
 * the corner of the screen has to be able to answer "is the new build live?".
 * That only works if the version travels *inside* the JavaScript that is
 * actually executing - a separately cached text file could disagree with the
 * bundle that loaded it, which is exactly the confusion this is meant to end.
 *
 * No network request is involved, and nothing but these four values is exposed.
 */
function buildInfo(): { version: string; commit: string; time: string; mode: string } {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as
    { version?: string };
  const version = typeof pkg.version === 'string' ? pkg.version : '0.0.0';

  // Prefer whatever the CI provider exposes, so a build made without a `.git`
  // directory still identifies itself. Netlify, Vercel, GitHub Actions and
  // Cloudflare Pages all publish the commit under one of these.
  const env = process.env;
  const ciCommit = env.COMMIT_REF
    ?? env.VERCEL_GIT_COMMIT_SHA
    ?? env.GITHUB_SHA
    ?? env.CF_PAGES_COMMIT_SHA
    ?? '';

  let commit = ciCommit.slice(0, 7);
  if (!commit) {
    try {
      commit = execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString().trim();
    } catch {
      // No git, no CI: a local build says so rather than inventing a hash.
      commit = 'dev';
    }
  }

  return {
    version,
    commit: commit || 'dev',
    time: new Date().toISOString().slice(0, 16).replace('T', ' '),
    mode: env.NODE_ENV === 'development' ? 'development' : 'production',
  };
}

export default defineConfig(({ command }) => {
  const info = buildInfo();
  // `vite dev` is always a development build, whatever the environment says.
  const mode = command === 'serve' ? 'development' : info.mode;
  return {
    base: './',
    define: {
      __APP_VERSION__: JSON.stringify(info.version),
      __APP_COMMIT__: JSON.stringify(command === 'serve' ? 'dev' : info.commit),
      __APP_BUILT__: JSON.stringify(info.time),
      __APP_MODE__: JSON.stringify(mode),
    },
    server: {
      port: 5173,
      strictPort: false,
      open: false,
    },
    preview: {
      port: 4173,
      strictPort: false,
    },
    worker: {
      format: 'es',
    },
    build: {
      target: 'es2022',
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 1800,
    },
  };
});
