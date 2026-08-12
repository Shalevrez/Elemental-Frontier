# Changelog

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
