# Elemental Frontier

A first-person sandbox adventure of **smooth, freely deformable terrain**, elemental powers and four
blighted shrines. It runs entirely on your own machine: no server, no account, no network calls after
`npm install`, and no downloaded assets — every shape, colour and sound in the game is generated
procedurally at runtime.

You wake at the heart of the **Sundered Verdance**, a finite world of rounded hills, river basins,
forests and drifting fog. Four elemental shrines stand blighted at the compass points. Cleanse all
four and the Verdance mends.

The world itself chooses what you are. You do not pick.

The terrain is a **scalar density field rendered as a smooth isosurface**, so you can carve craters,
drive tunnels sideways into a hillside, open overhangs and build the ground back up again — none of
it made of blocks.

---

## Table of contents

- [Quick start (Windows / PowerShell)](#quick-start-windows--powershell)
- [All commands](#all-commands)
- [Deploying (Netlify)](#deploying-netlify)
- [Controls](#controls)
- [Elemental affinity](#elemental-affinity)
- [Abilities](#abilities)
- [Smooth terrain and Terrain Mode](#smooth-terrain-and-terrain-mode)
- [World modes: Normal and Peaceful](#world-modes-normal-and-peaceful)
- [The shrines](#the-shrines)
- [Creatures](#creatures)
- [Combat](#combat)
- [Staying alive: regeneration, food, potions and rest](#staying-alive-regeneration-food-potions-and-rest)
- [Graphics settings](#graphics-settings)
- [Save data](#save-data)
- [Project structure](#project-structure)
- [Tests](#tests)
- [Troubleshooting](#troubleshooting)
- [Resetting or deleting your save](#resetting-or-deleting-your-save)
- [Known limitations](#known-limitations)

---

## Quick start (Windows / PowerShell)

Requirements: **Node.js 18 or newer** (developed on Node 24) and a browser with WebGL2 — Chrome,
Edge or Firefox all work.

Open PowerShell in the project folder and run:

```bash
npm install
```

```bash
npm run dev
```

Vite prints the address it is serving on. It is normally:

```text
http://localhost:5173
```

If port 5173 is already taken, Vite automatically picks the next free port (5174, 5175, …) and
prints **that** URL instead — always use the URL shown in the terminal. Open it, click **New
World**, choose Normal or Peaceful, and the Verdance is generated on your machine.

Press **Escape** at any time to pause and release the mouse. Click the game window to lock the mouse
again.

> Audio only starts after your first click. That is a browser autoplay rule, not a bug.

---

## All commands

| Command | What it does |
| --- | --- |
| `npm install` | Installs the four dependencies (Three.js, TypeScript, Vite, Vitest). |
| `npm run dev` | Starts the local dev server with hot reload at `http://localhost:5173`. |
| `npm run build` | Type-checks the whole project (`tsc --noEmit`) then builds to `dist/`. |
| `npm run preview` | Serves the built `dist/` locally (default `http://localhost:4173`). |
| `npm test` | Runs the Vitest suite once and exits. |
| `npm run test:watch` | Runs the tests in watch mode. |
| `npm run typecheck` | Type-checks without building. |

The game itself still makes no network calls: once the page has loaded, everything runs in your
browser and nothing is uploaded or fetched.

---

## Deploying (Netlify)

The repository is a static site — `npm run build` produces a self-contained `dist/` folder with no
server side at all, so Netlify only has to build it and serve the files.

`netlify.toml` at the repository root holds the whole configuration:

| Setting | Value |
| --- | --- |
| Build command | `npm run build` |
| Publish directory | `dist` |
| Node version | 20 |

Connect the repository in the Netlify UI (**Add new site → Import an existing project → GitHub**) and
pick this repository. Netlify reads `netlify.toml`, so leave the build settings it offers untouched.
Every push to the deployed branch triggers a rebuild; pull requests get deploy previews.

Two notes about how the site is served:

- Hashed files under `/assets/*` are sent with a one-year immutable cache header, while
  `index.html` is always revalidated, so a new deploy is picked up immediately.
- `vite.config.ts` sets `base: './'`, so the build uses relative URLs and works unchanged at a
  Netlify subdomain, a custom domain or a deploy-preview URL.

The mesher runs in an ES module worker, which needs a secure context — Netlify serves everything
over HTTPS, so this works out of the box.

---

## Controls

### Always

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| Mouse | Look |
| `Space` | Jump (hold to swim upward in water) |
| `Shift` | Sprint — and **fine control** while shaping terrain |
| `Tab` | Toggle **Element Mode** / **Terrain Mode** |
| `E` | Interact: cleanse a shrine, gather a mote, forage, loot, **hold to rest** |
| `H` | Use the best available healing item |
| `I` | Open / close the satchel |
| `Escape` | Pause and release the mouse |
| `F3` | Toggle the performance readout |
| `F9` | Toggle the combat debug overlay (development builds only) |

### Element Mode

| Input | Action |
| --- | --- |
| Left mouse | Primary elemental ability |
| Right mouse | Secondary elemental ability |

### Terrain Mode

| Input | Action |
| --- | --- |
| Left mouse (hold) | **Excavate** with a smooth spherical brush |
| Right mouse (hold) | **Deposit** terrain with the same brush |
| Mouse wheel | Choose the terrain material to deposit |
| `[` / `]` | Shrink / grow the brush |
| `Shift` (held) | Reduce brush strength for fine sculpting |

A translucent sphere previews exactly what the brush will affect.

### Elemental Convergence only

| Input | Action |
| --- | --- |
| `1` `2` `3` `4` | Switch to Air / Water / Earth / Fire |

Players with a single element **cannot** switch. The number keys do nothing for them, and their HUD
only ever shows their own element.

### Changed in this update

`Tab` now toggles **Terrain Mode** rather than the old Build Mode; left/right mouse there excavate
and deposit instead of breaking and placing blocks. `[`, `]`, `H` and `I` are new.

---

## Elemental affinity

The affinity is rolled **once**, at the moment a brand new world is created, from these exact
integer weights:

| Affinity | Weight | Chance |
| --- | ---: | ---: |
| Earth | 3 | 3/11 ≈ **27.27 %** |
| Fire | 3 | 3/11 ≈ **27.27 %** |
| Water | 2 | 2/11 ≈ **18.18 %** |
| Air | 2 | 2/11 ≈ **18.18 %** |
| **Elemental Convergence** (all four) | 1 | 1/11 ≈ **9.09 %** |

Total weight: **11**. These probabilities are unchanged by this update.

The roll lives in one small pure function, [`rollAffinity`](src/elements/affinity.ts), and is never
nudged, re-rolled or overridden anywhere in the game.

### When the roll does and does not happen

| Event | Rerolls? |
| --- | --- |
| Creating a completely new world | **Yes** |
| Deleting the save and creating another world | **Yes** |
| Refreshing the browser | No |
| Dying and respawning | No |
| Continuing a saved world | No |
| Switching between Normal and Peaceful Mode | No |
| Loading a save with corrupt fields but a valid affinity | No — the affinity is kept, the rest is repaired |
| Migrating an older block-based save | No |

### Single-element play

If you roll Earth, Fire, Water or Air you get **only that element's** primary, secondary, passive,
visuals, sounds, tutorial and shrine upgrades. The other three are not unlockable in that world.

### Elemental Convergence

The rare 1-in-11 result. You hold all four elements but only one at a time, switched with `1`–`4`
and gated by a short switching cooldown. In exchange for the versatility, Convergence receives a
slightly smaller focused power bonus from shrine blessings.

**Every affinity can complete every shrine, in both world modes.**

---

## Abilities

Every active ability costs **aether**, has its own cooldown, particle effect and synthesised sound.

| Element | Primary (LMB) | Secondary (RMB) | Passive |
| --- | --- | --- | --- |
| **Air** | **Gust** — wide cone of wind, light damage, heavy knockback, deflects slow enemy bolts back at them | **Air Dash** — snap forward; one extra dash while airborne, refreshed on landing; negates fall damage when timed | **Featherstep** — higher jump, faster sprint, greatly reduced fall damage |
| **Water** | **Water Whip** — curving lash that damages and slows; ~30 % stronger near open water | **Freeze** — locks up nearby creatures and, over open water, conjures a walkable sheet of bound ice | **Tidemend** — near water, recovery starts sooner and runs faster, and food and potions heal more |
| **Earth** | **Rock Shot** — a heavy irregular boulder that dents the ground where it lands | **Raise Wall** — sculpts a smooth earthen ridge out of the terrain, then lets it crumble away | **Rootbound** — less knockback and less physical damage on firm ground |
| **Fire** | **Fireball** — fast glowing ember that bursts and applies burning | **Flame Wave** — fan of ground fire that ignites everything it reaches and stops at walls | **Last Ember** — fire damage rises as your health falls |

### Earth on smooth terrain

**Rock Shot** throws a genuinely irregular boulder (a noise-displaced icosphere), and its impact
leaves a shallow temporary dent in the ground.

**Raise Wall** is now a real piece of sculpted terrain: a row of overlapping spherical deposits that
blend into the surrounding ground as a tapered ridge. It has correct collision, blocks creatures and
projectiles, refuses protected shrine ground, never grows into the space you occupy, and crumbles
away after about eleven seconds. Temporary edits record the exact **delta** they applied to each
density sample and subtract it again on expiry, so overlapping deposits restore the terrain
perfectly regardless of the order they expire in — and they are never written to the save file.

---

## Smooth terrain and Terrain Mode

### How the terrain works

The world is a **scalar density field** sampled on a 257 × 65 × 257 lattice. A sample greater than
zero is solid, less than zero is open air, and the visible surface is the isosurface at exactly
zero. Nothing is a block.

The field is meshed with **Naive Surface Nets** (a dual-contouring method): every cell that straddles
the surface gets one vertex placed at the average of its edge crossings, and quads are stitched
across every lattice edge that changes sign. Vertex normals come from the density gradient, so
shading stays smooth across chunk borders. Material, slope, height and three scales of noise are
baked into vertex colours at mesh time, which gives the ground mottled variation without a single
texture lookup.

Because vertices move continuously with the density values, editing the field **deforms** the
surface instead of removing cubes.

### Chunks and performance

The world is split into 8 × 2 × 8 = **128 chunks** of 32³ cells. Each chunk meshes one cell beyond
its own lower edge, which is what stops cracks appearing at chunk borders.

When you edit terrain:

- Only the chunks whose meshing region touches the brush are marked dirty.
- Meshing runs in a **Web Worker**: the main thread copies the padded density block into a
  transferable buffer and the worker transfers finished geometry back. No `SharedArrayBuffer`, so no
  cross-origin isolation headers are needed and the game still runs from a plain local dev server.
  If a worker cannot be created the game falls back to time-budgeted meshing on the main thread.
- Stale results are discarded with a per-chunk token, so fast repeated edits never flicker.
- Replaced geometry is disposed immediately.

Collision is continuous: the player is a stack of spheres resolved against the density field, so
slopes, craters, tunnels and overhangs all work without any axis-by-axis special cases, and
collision is correct the instant an edit lands.

### Terrain Mode

Press `Tab`. Left mouse excavates, right mouse deposits, both with a smooth spherical falloff so
added material blends in as a mound rather than a pasted-on ball.

Materials: **Soil**, **Stone**, **Sand**, **Clay** and **Blightmatter** (locked until you have
actually collected some). Excavating collects the material you dug; depositing consumes the selected
one. The HUD shows the selected material, how much you carry, and the current brush size.

Protected shrine foundations refuse to be shaped, and the game frees you if terrain shaping ever
leaves you embedded in the ground.

### How terrain edits are saved

The base world stays perfectly deterministic from its seed, so the save only records what **you**
changed: a journal of brush strokes, each `{x, y, z, radius, strength, material}` quantised to two
decimals and stored as a flat array of numbers. Loading replays the journal onto the freshly
generated field. This is compact (7 numbers per stroke, capped at 6000 strokes), versioned, and
reconstructs your excavations to within the quantisation error (measured max density difference on a
real reload: **0.0125**).

---

## World modes: Normal and Peaceful

Choose when you create a world, and change your mind at any time from the pause menu — **no new
world required**. The current mode is shown on the New World screen, the Continue card, the pause
menu and the HUD.

### Normal Mode

Corrupted creatures roam the Verdance and a guardian defends every blighted shrine.

### Peaceful Mode

- No hostile creature ever spawns.
- Switching it on safely dissolves every creature already in the world and cancels their projectiles.
- Shrine guardians do not appear.
- Exploration, terrain shaping, elemental powers, blessings and shrine progress all remain.
- Falling and drowning still hurt you — you are not invincible.

### Switching back to Normal

You are warned first. Then:

- Spawning resumes only after a grace period, so nothing appears on top of you.
- New creatures spawn at least 24 m away (measured: nearest spawn 37 m, none within 20 m).
- Guardians are restored **only** for shrines you have not yet cleansed.

---

## The shrines

Four sculpted shrines sit far apart at the compass points, each with its own silhouette built from
lathes, tori and rounded boulders — no cubes anywhere:

- **Shrine of the Whispering Gale** (north) — a slender spire ringed by floating hoops
- **Shrine of the Sunken Chorus** (east) — a sunken basin encircled by tapered columns
- **Shrine of the Stoneheart** (south) — a cairn of stacked rounded boulders among standing stones
- **Shrine of the Emberfall** (west) — a jagged obelisk with rising arms

### Normal Mode: the guardian

Approaching wakes the guardian. Once it falls, hold `E` at the shrine to cleanse it.

### Peaceful Mode: the ritual

Three **elemental motes** hover in the country around each shrine. Find them, gather each with `E`,
then return to the shrine and hold `E` to complete the cleansing ritual. The HUD tells you how many
remain. The reward is identical to Normal Mode.

Neither gate ever depends on your element.

### Blessings

Granted in cleansing order regardless of which shrine you did first or which mode you are in:

1. **Blessing of Vitality** — +30 max health, full heal, +8 % elemental power
2. **Blessing of the Wellspring** — +35 max aether, +2.5 regeneration, +8 % elemental power
3. **Blessing of Quickening** — all cooldowns −20 %, +10 max health, +8 % elemental power
4. **Blessing of Striding** — +14 % movement speed, +15 max aether, +10 % elemental power

No blessing ever grants another element.

---

## Creatures

- **Corrupted Crawler** — a low rounded quadruped with a glowing spine. Weak to fire and earth.
- **Corrupted Wisp** — a floating glowing core wrapped in orbiting shards. Weak to air; its slow
  bolts can be swatted back with Gust.
- **Shrine Guardian** — a large sculpted figure with a floating crown, 460 health and three attacks:
  a melee sweep, a ground shockwave and a three-orb volley. It takes normal damage from every
  element.

All of them run a full state machine (idle → detect → chase → attack → hurt → defeated), show a
health bar when hurt, and react to knockback, stagger, slow, freeze and burn.

---

## Combat

### How an attack decides what it hits

Every ability resolves its aim the same way, so what the crosshair covers is
what the attack reaches:

1. A ray is cast from the centre of the screen.
2. The first thing it meets — terrain, or the ability's maximum range — becomes
   the target point.
3. The effect is drawn leaving your hand, but its direction is measured from
   the hand **to that target point**, so it converges on what you aimed at.

Creatures are solid bodies, not points: each one carries a vertical capsule
covering it from foot to head, slightly padded so a near-miss still counts. A
tall creature can be hit at the head or the ankles, not only dead centre.

Fast projectiles are tested continuously — the whole path travelled since the
previous frame is swept against those capsules, so nothing slips between two
frames. Aim assist is deliberately small: it bends the shot by a few degrees
toward a body the crosshair is already almost on, it never moves the camera,
and it never reaches through a wall or past the ability's range.

### Reading the crosshair

| Crosshair | Meaning |
| --- | --- |
| Plain | Nothing targeted |
| Tight white ring | A creature is targeted and reachable |
| Dashed grey ring | The shot is stopped by terrain |
| Faded, wide ring | The ability is on cooldown |
| Dotted blue ring | Not enough energy |
| Red dashed ring | Cannot cast right now |

When a hit lands the crosshair flashes differently depending on what happened —
a normal hit, a critical, a status application, a blocked hit, a resisted hit,
an immune target, or a kill.

### The water combo

Water Whip is a short stream rather than a single bullet. It stays out for
about a third of a second, tracks where you look, and can damage the same
creature only every 0.12 s, so its damage is predictable. It leaves the target
**Wet** and **Slowed**.

Freeze on a soaked target locks it down for far longer than on a dry one, and
frozen bodies turn pale and glassy. Hitting frozen ice with Earth shatters it.
So the full chain is: **soak, freeze, break**.

### Combat debug overlay (development only)

Run `npm run dev` and press `F9`. It is off by default and cannot be switched
on in a production build.

It draws, in world space:

- the camera ray and the resolved target point,
- every creature's hit capsule (drawn thinner when out of line of sight),
- the current attack volume and live projectile paths,

and lists, in a panel at the bottom left: the ability range and distance to
the target, whether terrain blocked the ray, the targeted creature, the attack
tokens in use, the current cooldown and energy, and a rolling log of hits,
misses and their reasons. Nothing is drawn or logged while it is off.

## Staying alive: regeneration, food, potions and rest

Four distinct recovery methods, each with its own HUD feedback.

### 1. Automatic regeneration (every affinity)

- Begins **8 seconds** after you were last in combat.
- Restores **1.5 % of maximum health per second** (verified: exactly 19.5 HP in 10 s at 130 max).
- Stops the instant you take damage.
- Never exceeds maximum health.
- Will not run while you are drowning, while you have dealt damage recently, or while a hostile
  creature is hunting you nearby.
- Shown as a soft pulse on the health bar — no full-screen effect.

**Water's passive** does not duplicate this: near water it shortens the delay to 5 seconds, speeds
regeneration up by 35 %, and makes food and potions 20 % more effective.

### 2. Food

Gradual healing, blunted if you are hit. Found by foraging **sunberry bushes** and looting supply
caches.

| Item | Restores | Over | Interrupt |
| --- | --- | --- | --- |
| Sunberries | 20 | 6 s | keeps 35 % |
| Travelling Meal | 48 | 12 s | keeps 50 % |

### 3. Healing potions

Stronger, near-instant, uncommon, and on a shared cooldown so they cannot be chained. Found in
supply caches along the routes to the shrines.

| Item | Restores | Over | Cooldown |
| --- | --- | --- | --- |
| Minor Draught | 38 | 0.8 s | 10 s |
| Greater Draught | 85 | 1.2 s | 16 s |

Neither food nor potions can heal past maximum health, and neither can be used at full health.

### 4. Resting

Walk up to a **campfire** or a **cleansed shrine** and hold `E` for about three seconds. Resting
fully restores health, refills aether, clears cooldowns, saves the game, moves your respawn point,
and nudges the time of day forward. It is interrupted by damage, and is refused in Normal Mode while
a hostile creature is close. In Peaceful Mode it is always available at a valid site.

### The `H` key

Uses the most appropriate item for the damage you have taken: food for a scratch, a minor draught
for a moderate wound, and the greater draught only when you are badly hurt. It never fires at full
health and never wastes a big item on a small injury. You can also pick items manually from the
satchel (`I`).

---

## Graphics settings

Three presets plus individual controls, all applied immediately and saved locally.

| | Low | Medium (default) | High |
| --- | --- | --- | --- |
| Render distance | 6 | 9 | 13 |
| Shadows | off | on, 1024 | on, 2048 |
| Terrain detail | 0.6 | 1.0 | 1.4 |
| Particle density | 0.4 | 1.0 | 1.4 |
| Post-processing / bloom | off | on | on |
| Anti-aliasing | off | on | on |

Measured on the development machine with 16 creatures, live projectiles and heavy particle load
(uncapped, no vsync): **Low ≈ 6.1 ms/frame, Medium ≈ 10.3 ms, High ≈ 11.8 ms**, and **12.7 ms while
actively excavating** on Medium. All comfortably above 60 fps.

The post stack is Three.js `EffectComposer` with bloom, a custom colour-grade pass (contrast,
saturation, warm tint, vignette) and FXAA. If it fails to initialise the game silently renders
without it.

---

## Save data

Everything lives in your browser's LocalStorage under two keys:

- `elemental-frontier/world` — the world
- `elemental-frontier/settings` — audio, sensitivity, FOV and all graphics settings

The world save (**version 3**) holds the save-data version, world seed, elemental affinity, the
active element for Convergence, the **world mode**, per-shrine cleansed / guardian / mote state, your
position and view angles, respawn point, health, aether, blessings earned, carried terrain materials,
healing items, the **terrain brush journal**, which props you have looted, playtime and tutorial
state.

Autosave happens periodically (every 20 s), when you cleanse a shrine, gather a mote, loot a cache,
rest, pause, change a setting, die, switch world mode, and before returning to the title screen.

### Migration from older (block-based) saves

A version 2 save is migrated rather than rejected:

- Affinity, seed, shrine progress, guardians, blessings, health, playtime and tutorial state are all
  **kept**. A valid affinity is never rerolled.
- The old block inventory is converted into comparable amounts of the new terrain materials.
- The old cube-edit map **cannot** be faithfully converted into a density field, so it is dropped and
  the terrain returns to its deterministic seed shape. The game tells you this on the title screen
  rather than failing.
- A small starting supply of healing items is granted.
- The world defaults to Normal Mode.

Loading is otherwise defensive: unreadable JSON, the wrong shape, or a missing seed or affinity is
rejected cleanly and you are offered a new world instead of a crash.

---

## Project structure

```
elemental-frontier/
├── index.html                  page shell, all UI screens, original SVG symbol sheet
├── vite.config.ts              dev/build configuration (ES-module workers)
├── vitest.config.ts            test configuration
├── tsconfig.json               strict TypeScript configuration
├── tests/                      Vitest suites (no WebGL required)
│   ├── affinity.test.ts        weighted selection, boundaries, persistence rules
│   ├── terrain.test.ts         density field, Surface Nets, edit journal, dig/fill/tunnel
│   ├── healing.test.ts         regeneration timing, food, potions, resting
│   ├── save.test.ts            validation, v2 migration, hostile storage
│   └── gameplay.test.ts        inventory, peaceful ritual, blessings, cooldowns, tutorial
└── src/
    ├── main.ts                 application bootstrap + WebGL capability check
    ├── style.css               all interface styling
    ├── core/
    │   ├── rng.ts              seeded PRNG, value/fbm/ridged noise, seed coercion
    │   ├── cooldown.ts         cooldown state and scaling
    │   └── Input.ts            keyboard, mouse and pointer lock
    ├── world/
    │   ├── coords.ts           world dimensions, field and chunk indexing
    │   ├── materials.ts        terrain material definitions
    │   ├── density.ts          the scalar field: generation, sampling, gradients
    │   ├── surfaceNets.ts      the isosurface mesher (smooth dual contouring)
    │   ├── mesher.worker.ts    off-main-thread chunk meshing
    │   ├── terrainEdits.ts     brush-stroke journal, serialisation, brush limits
    │   ├── World.ts            chunk management, collision, raycasting, editing
    │   ├── Flora.ts            instanced trees with wind
    │   ├── Props.ts            campfires, berry bushes, supply caches
    │   ├── Water.ts            animated sea surface shader
    │   ├── shrineData.ts       shrine placement, ritual, objective logic, blessings
    │   └── Shrines.ts          shrine presentation, guardians, motes, cleansing
    ├── render/
    │   ├── Renderer.ts         renderer, sky, lighting, fog, post stack, brush preview
    │   └── models.ts           every smooth 3D model in the game
    ├── player/
    │   ├── Player.ts           movement, density collision, vitals, drowning
    │   └── inventory.ts        terrain materials, healing items, quick-heal choice
    ├── elements/
    │   ├── affinity.ts         the weighted affinity roll and its rules
    │   ├── elements.ts         element and ability definitions (data)
    │   └── abilities.ts        runtime behaviour of all eight abilities
    ├── combat/
    │   ├── Enemies.ts          creature bodies, AI, damage, drops, peaceful mode
    │   └── Projectiles.ts      pooled projectiles and deflection
    ├── fx/
    │   └── Particles.ts        pooled GPU particle system
    ├── audio/
    │   └── AudioEngine.ts      every sound, synthesised with the Web Audio API
    ├── save/
    │   └── saveData.ts         save schema, validation, v2 migration, settings
    ├── ui/
    │   └── UI.ts               screens, HUD, compass, satchel, tutorial, overlays
    └── game/
        ├── Game.ts             state machine, main loop, system wiring
        ├── Healing.ts          regeneration, food, potions, resting (pure)
        └── Tutorial.ts         adaptive tutorial steps
```

---

## Tests

```bash
npm test
```

**158 tests across five suites**, all pure logic with no WebGL requirement:

- **Affinity** — total weight is exactly 11, the exact weight table, every integer roll in `0..10`
  maps to the correct affinity, boundaries, hostile random sources, a uniform sweep producing
  exactly 3000/3000/2000/2000/1000, and the rule that single-element players are locked to their
  element even if the save says otherwise.
- **Terrain** — field indexing and chunk padding, material rules, the brush journal (serialisation,
  repeated round trips, malformed strokes, the storage cap), deterministic generation, density
  clamping, gradients, and Surface Nets itself: empty and full blocks produce nothing, a flat plane
  produces upward normals, the surface lands on the isosurface rather than a cell boundary, a sphere
  produces overwhelmingly diagonal normals (a cube mesher could not), and the index buffer is valid.
  Then the edit maths: digging opens a hole, depositing fills it, **digging sideways creates a tunnel
  with solid rock above and below it**, replaying a serialised journal reproduces the field exactly,
  and edits stay local to the brush.
- **Healing** — the 8-second delay, the 1.5 %/s rate, stopping on damage, the maximum-health cap,
  dealing damage counting as combat, hostile pressure, damage-over-time, the Water passive
  (shorter delay, faster rate, better consumables, no effect for other elements), food healing
  gradually, potions being refused at full health / on cooldown / when absent, no double-stacking,
  interrupt behaviour, and every resting rule.
- **Save** — creation, validation, rejection of unusable payloads, world-mode repair, mote
  normalisation, terrain-op persistence and reconstruction, **v2 migration** (affinity never
  rerolled, progress kept, block edits reported as dropped, inventory converted), hostile storage,
  quality presets and formatting helpers.
- **Gameplay** — terrain material inventory including fractional amounts, healing item counts, the
  quick-heal choice table, shrine progress, the peaceful ritual gate (`canCleanse` in both modes),
  blessing accumulation, cooldowns, element definitions and the adaptive tutorial.

---

## Troubleshooting

**The page is black or says WebGL is unavailable.**
The game needs WebGL2. Update your browser or graphics driver, and make sure hardware acceleration
is enabled.

**Port 5173 is already in use.**
Vite falls back to the next free port automatically. Read the URL it prints in the terminal.

**Performance is poor.**
Open Settings and pick the **Low** quality preset. It turns off shadows and post-processing and pulls
the render distance in; on the development machine it roughly halves the frame cost.

**Digging feels heavy on a slow machine.**
Lower **Terrain detail** in Settings — it shrinks the per-frame meshing budget.

**I dug down and hit water.**
Sea level is 18. Anything you excavate below it is below the water table and floods. Watch the breath
meter; drowning does real damage.

**I fell into terrain / I am stuck.**
The game detects this and lifts you free after a moment. Falling out of the world puts you back on
solid ground.

**There is no sound.**
Click once anywhere first (browser autoplay policy), then check the mute toggle and master volume.

**PowerShell says running scripts is disabled.**
Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` in an elevated PowerShell, or use
`npm.cmd run dev`.

---

## Resetting or deleting your save

1. **In game** — on the title screen click **Delete Save**, then confirm. Settings are kept.
2. **In game** — click **New World**. You are asked to confirm, then a new seed is generated and a
   new affinity is rolled.
3. **From the browser console** — press `F12`, open Console, and run:

   ```js
   localStorage.removeItem('elemental-frontier/world');     // world, terrain edits, affinity
   localStorage.removeItem('elemental-frontier/settings');  // audio, FOV, graphics
   ```

   Then reload the page.

---

## Known limitations

- The world is finite (256 × 256 units, 64 tall). The border rises into impassable cliffs and the
  game warns you when you approach them.
- The density lattice is one sample per world unit. That is what keeps 128 chunks meshing quickly,
  but it also sets the finest detail you can sculpt: the smallest brush is about 1.5 units across.
- Water is a single animated plane at sea level rather than a simulated fluid. It does not flow, and
  any excavation below sea level reads as flooded even inland.
- Terrain edits are capped at 6000 brush strokes per world; the oldest are dropped beyond that.
- Trees and props are removed rather than made to topple when you dig the ground out from under them.
- There is no ambient occlusion or global illumination; lighting is one directional sun plus a
  hemisphere fill, with shadows cast within a limited radius around the player.
- Creature pathfinding is deliberately simple — they steer toward you and hop small ridges, but they
  will not solve a maze you excavate for them.
- Mobile and touch controls are not implemented.
- Old version 2 block-terrain edits cannot be converted and are dropped on migration (everything else
  in those saves is preserved).

---

## Originality

Every asset is generated by this project at runtime: terrain colour is computed at mesh time,
creatures, shrines, trees and props are built from rounded primitives, all interface symbols are
hand-authored inline SVG, and every sound is synthesised with oscillators and filtered noise through
the Web Audio API. The world, its creatures, its shrines, its terminology and its visual design are
original to Elemental Frontier. Nothing is copied from any existing game.
