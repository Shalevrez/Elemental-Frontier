/**
 * Elemental Frontier - application bootstrap.
 *
 * Runs entirely in the browser: no server, no network, no external assets.
 */

import './style.css';
import { Game } from './game/Game';

function fail(message: string, detail?: unknown): void {
  // eslint-disable-next-line no-console
  console.error('[Elemental Frontier]', message, detail ?? '');
  const app = document.getElementById('app');
  if (!app) return;
  const panel = document.createElement('div');
  panel.style.cssText =
    'position:absolute;inset:0;display:grid;place-items:center;padding:8vh 6vw;text-align:center;' +
    'background:#070a12;color:#e8f0fb;font-family:"Trebuchet MS",Segoe UI,sans-serif;z-index:99';
  panel.innerHTML =
    `<div style="max-width:52ch"><h1 style="letter-spacing:.2em;text-transform:uppercase;font-size:1.2rem">Elemental Frontier could not start</h1>` +
    `<p style="color:#93a5be;line-height:1.6">${message}</p>` +
    `<p style="color:#63748d;font-size:.8rem">Check the browser console for details. WebGL2 and a modern browser are required.</p></div>`;
  app.appendChild(panel);
}

function boot(): void {
  const canvas = document.getElementById('scene');
  if (!(canvas instanceof HTMLCanvasElement)) {
    fail('The rendering canvas is missing from the page.');
    return;
  }

  // Verify WebGL before Three.js throws something less readable.
  const probe = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
  if (!probe) {
    fail('This browser or graphics driver did not provide a WebGL context.');
    return;
  }

  try {
    const game = new Game(canvas);
    game.start();
    // Expose for debugging in the browser console; harmless in production.
    (window as unknown as { elementalFrontier?: Game }).elementalFrontier = game;
  } catch (error) {
    fail('An unexpected error occurred while starting the game.', error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
