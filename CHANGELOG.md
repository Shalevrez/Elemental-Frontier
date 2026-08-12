# Changelog

## v1.0.2 — Black screen after the Beacon transition

### The bug

Taking the World Beacon left the screen completely black, and the next world
never became playable.

The cause was two features quietly sharing one key. The Beacon is deliberately
sited **beside the shrine the player finished last** — and a cleansed shrine is
also a **rest site**. Both are used by *holding* `E`. So holding `E` at the
Beacon did both things at once: it charged the hold to travel, and it started a
rest. A rest draws a full-screen opaque blackout.

The moment the hold committed, the world was torn down and the game left the
playing state. From that frame on, the only code that ever takes the blackout
down — which runs while the player is standing at a rest site, in a world that
still exists — never ran again. Arriving in the destination reset the rest
state to "not resting", so even the release path was skipped. The next world
loaded correctly, ran correctly and was fully playable underneath an opaque
black layer that nothing would ever remove.

### The fix

- **Inside its own radius, the Beacon owns the interact hold.** A player who
  walked to the way out is leaving, not sleeping. Resting is unchanged
  everywhere else — at every campfire, at every other shrine, and a few paces
  away on the same shrine, whose rest radius is wider than the Beacon's.
- **The black fade itself is untouched.** Its length, its opacity and how
  resting uses it are exactly as they were; the bug was ownership of the key and
  missing cleanup, and that is what changed.
- **Every load now starts from a clean slate of overlays** — fade, prompt,
  interact holds, cleanse progress, queued story beat, hit-stop — so no future
  overlay can survive a world change either.

### Transitions are now recoverable

- **Added a transition state machine** (`src/game/transition.ts`) that owns the
  in-flight flag, the pre-transition save snapshot and the stall backstop. It is
  engine-free, so the whole lifecycle is driven deterministically in tests
  rather than needing a browser.
- **Rollback actually reaches the failure.** The old `try`/`catch` wrapped
  `beginLoad`, which only *starts* the loader — every real failure happens
  frames later while the world is being built, where nothing was catching it. A
  failure at any point now restores the pre-transition save, and the player
  lands back at their last checkpoint with every upgrade, reward and affinity
  intact.
- **A failed transition no longer disables the Beacon for the session.** The
  in-flight flag used to be cleared only on success.
- **A stall backstop** ends a transition that has genuinely stopped producing
  anything for 45 seconds. It measures *silence*, not duration — any progress
  resets it — so a slow machine still finishes rather than being thrown out.
- **The frame stops at the transition.** `updatePlaying` used to keep running
  for another forty lines after the Beacon replaced the world: an autosave
  landing on that frame wrote the old position and terrain over the destination
  that had just been committed, and a queued story beat took the state away from
  the loader, which then never advanced again.
- **A loading state with nothing left to advance now recovers** instead of
  sitting on a dead frame that never renders.
- **Beacon activation is idempotent** — a second commit is refused rather than
  stacking a second world load.
- **The Beacon's own geometry and materials are disposed** when it is used. The
  terrain material, prop atlas and render targets are shared and deliberately
  left alone.
- **A destination position that is not a finite number** falls back to the
  validated spawn rather than propagating into the camera.

### Loading presentation

The loading title was fixed in the markup and read "Shaping the Verdance"
whichever world was actually being built. It now names the destination, above
the existing spinner, progress bar and per-stage message.

### Compatibility

Save schema unchanged at version **5**. No migration, no reset, no rerolled
affinity, no lost upgrades. A save already sitting in an affected world is
unaffected by the bug in the first place — the blackout lived only in the page,
never in the save, so reloading such a save already showed the world correctly,
and it still does.

## v1.0.1 — World Beacon hotfix

### World travel was unavailable in practice

Restoring every shrine in a world opened the exit **at the centre of the
world**, announced it with a five-second toast, and showed the prompt to use it
only within three metres. The compass rendered marks for the four shrines and
nothing else — so once a world was finished, every mark read "cleansed" and
nothing at all pointed at the way out. A player who finished their last shrine
at the world edge had completed the world with no visible or functional way to
continue.

- **Added the World Beacon.** A grounded plinth under a ninety-metre column of
  light, placed beside the shrine you finished last on validated level, dry,
  open ground — clear of water, lava, props and cliffs, with headroom, and
  deterministic so it stands in the same place on every load. Falls back through
  outward search rings and then to the validated respawn resolver.
- **Added a compass marker and objective marker** for the Beacon, with live
  distance. This is the connection that was missing.
- **Travel is now hold-`E`**, not a tap, with a progress bar, the destination
  named, and disabled feedback while a transition is already running.
- **Beacon ground is protected** from terrain deformation, and only its plinth
  is solid — the beam is light.
- **Existing completed saves light a Beacon on load.** It is reconstructed from
  the shrine flags the save already had, so there is no migration, nothing is
  reset, no guardian is re-fought, and no reward, chest or affinity is rerolled.
- **New Game Plus through the Beacon now asks for confirmation** first.

### First-world difficulty

Verdant Ruins was finishable in about five minutes.

- Encounter budget `×0.85 → ×1.0` and elite rate `×0.6 → ×0.85`. At the old
  elite rate a player could cross the entire first world without meeting one.
- Shrine Guardian base health `460 → 560`, and the Rootwarden's own scale
  `0.82 → 0.95`. At the old values a focused Fire adept removed it in roughly
  twelve seconds — before its second phase, let alone its third.
- **Phase-skip protection:** a guardian now advances at most one phase per
  crossing, so a single large hit can no longer carry it past the middle phase
  unseen. It costs a strong build only the recovery windows, never invulnerability.
- Verdant Ruins remains the gentlest world in the campaign on every axis, and
  the campaign difficulty curve still climbs strictly.

### Fire

- **Fixed double-counted explosion damage.** A direct Fireball hit resolved in
  full through the projectile sweep, and then the blast that followed included
  the same creature again at 45 %. A direct hit was worth **145 %** of the
  Fireball's stated damage against its own target, and applied burning twice.
  The blast now skips the creature the shot hit directly; neighbours are
  unaffected. This was the single largest reason Fire outran the campaign.
- Burning stacks and duration were audited and were already bounded (5 stacks,
  4 seconds); no change was needed.
- Fire keeps its aggressive identity and its damage lead.

### Visible build version

- Added a small, non-interactive label in the bottom-right corner showing
  `v1.0.1 • <short commit>`, with `Built <timestamp> UTC • <mode>` on hover and
  as its accessible label.
- The version is compiled into the JavaScript bundle by Vite `define` — never
  fetched — so it always describes the code that is actually running.
- `package.json` is the source of truth; the commit comes from the CI provider
  when present, otherwise from `git`, otherwise `dev`.
- Version bumped `1.0.0 → 1.0.1`, lockfile updated. No git tag was created.

### Compatibility

Save schema unchanged at version **5**. No migration. All live saves, builds,
affinities and progression are preserved. Peaceful Mode is unaffected: the
Beacon reads the same shrine flags the mote ritual already sets, and requires no
guardian, no hostile encounter and no combat-only item.
