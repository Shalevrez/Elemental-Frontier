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
- [The story](#the-story)
- [Worlds](#worlds)
- [Swimming and oxygen](#swimming-and-oxygen)
- [Chests](#chests)
- [Rewards and growth](#rewards-and-growth)
- [Reward cards and tradeoffs](#reward-cards-and-tradeoffs)
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
| `F10` | Toggle the collision debug overlay (development builds only) |

### Element Mode

| Input | Action |
| --- | --- |
| Left mouse | Primary elemental ability |
| Right mouse | Secondary elemental ability |
| `Q` | Elemental technique |
| Middle mouse **click** | Ultimate — only when the Ultimate meter is full |
| `R` | Ultimate, for anyone without a middle mouse button |

Middle-click and wheel scrolling are read as two completely separate inputs, so **scrolling the
wheel can never fire an Ultimate**. None of the Element Mode bindings are read in Terrain Mode.

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

`Tab` toggles **Terrain Mode** rather than the old Build Mode; left/right mouse there excavate and
deposit instead of breaking and placing blocks. `Q`, middle-click, `R` and `F10` are new: every
element now has four actives (primary, secondary, technique, Ultimate) rather than two.

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

Every active ability costs **Mana**, has its own cooldown, particle effect and synthesised sound.

| Element | Primary (LMB) | Secondary (RMB) | Technique (Q) | Ultimate (MMB / R) | Passive |
| --- | --- | --- | --- | --- | --- |
| **Air** | **Gust** — wide cone of wind, heavy knockback, deflects slow bolts back at their owner, clears smoke and fans fire | **Air Dash** — snap forward; one extra dash while airborne | **Air Blades** — three fast wind blades that pierce light creatures and ricochet off terrain | **Cyclone** — a tornado that walks forward, drags light creatures in, turns projectiles around and grinds heavies down | **Featherstep** — higher jump, faster sprint, greatly reduced fall damage |
| **Water** | **Water Whip** — curving lash that soaks, chills and slows; stronger near open water, and it wets the ground it lands on | **Freeze** — locks up nearby creatures, lays walkable ice over open water, and leaves slippery frost | **Tidal Pull** — drags soaked creatures together, interrupts wind-ups and sets up the freeze combo | **Maelstrom** — a rotating water field that pulls, soaks and grinds, then flash-freezes anything it has soaked enough | **Tidemend** — near water, recovery starts sooner and runs faster |
| **Earth** | **Rock Shot** — a heavy irregular boulder that dents the ground where it lands | **Raise Wall** — sculpts a real earthen ridge out of the terrain, then lets it crumble | **Seismic Slam** — cracks race through the ground, damaging, staggering and cratering as they go | **Tectonic Rupture** — reshapes the arena: shockwave, fractures, and a ring of cover left standing around you | **Rootbound** — less knockback and less physical damage on firm ground |
| **Fire** | **Fireball** — fast ember that bursts, scorches the ground and applies burning | **Flame Wave** — fan of ground fire that ignites everything it reaches and leaves the ground alight | **Flame Dash** — lunge inside a lance of fire, burning what you pass through and leaving a burning trail | **Inferno** — a firestorm that sets the arena alight and detonates every burning creature that falls in it | **Last Ember** — fire damage rises as your health falls |

### The Ultimate meter

Ultimates do **not** spend Mana. Each element has a separate Ultimate meter that fills by
*fighting*: dealing damage, applying elemental status, defeating creatures, chaining hits inside a
combo window, deflecting shots, shattering frozen targets, and using the terrain against something.
Taking damage also contributes, but only up to a quarter of the bar, so standing in fire is never a
charging strategy — and hitting scenery contributes nothing at all. Terrain interactions only pay
out when they actually connect with something, and are themselves capped per fill, so freezing bare
ground or cracking an empty field earns nothing.

Every source runs through one rolling **per-second ceiling**, which is what rate-limits multi-hit
abilities: twenty small hits in a frame are worth exactly what one large hit is worth. An Ultimate
grants **no charge at all** while it is running, so an Ultimate can never pay for the next one.
Between them these put a full meter at roughly **two to four meaningful encounters** for an active
player.

The Ultimate becomes available the moment you restore your first shrine. It needs a **full** meter,
spends all of it, has an eight-second lockout so it cannot be chained, never removes your control,
never makes you invulnerable, and stays unlocked — with its current charge — across every world
transition. Accessibility settings for reduced flashes, shake, distortion and particle density are
in the Settings screen.

### One element is a whole game

Every element supports at least three distinct build directions — Water: freeze/shatter,
healing/shields, streams and control; Fire: burning, explosions, aggression; Earth: defence, heavy
impact, terrain control; Air: mobility, knockback, reflection — with at least ten upgrades each,
per-element ability mutations, an Ultimate-specific epic, and a straight **+15 % affinity damage
bonus** that Elemental Convergence does not get. Convergence stays more flexible (all four
elements, capped at three upgrades per element) without being stronger.

### Terrain deformation in combat

Attacks are meant to change the arena, not leave it untouched.

- **Earth** cracks and craters the ground, raises real cover and leaves a ring of pillars after a
  Tectonic Rupture.
- **Fire** scorches the ground, leaves burning zones that hurt anything standing in them, and melts
  ice.
- **Water** leaves wet ground that puts fires out, freezes into slippery ice, and crusts lava over
  into temporary stone with a burst of steam.
- **Air** clears smoke and steam, fans nearby fires wider, and throws creatures into terrain and
  hazards.

Every deformation goes through one place, so the rules hold everywhere: a maximum radius per strike,
never on protected ground (shrine foundations, World Hearts, portals), a hard cap on live zones and
temporary edits, automatic cleanup on a timer, and immediate collision updates — the density field
*is* the collision, so a wall blocks you on the same frame it rises.

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
2. **Blessing of the Wellspring** — +35 max Mana, +2.5 regeneration, +8 % elemental power
3. **Blessing of Quickening** — all cooldowns −20 %, +10 max health, +8 % elemental power
4. **Blessing of Striding** — +14 % movement speed, +15 max Mana, +10 % elemental power

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

### The Mana economy

A full bar pays for several primary casts plus one real secondary or technique,
and regeneration continues *during* combat rather than stopping dead. Out of
combat it more than triples after a short lull, so there is never a reason to
stand still waiting for a bar.

When you cannot afford the full price, the primary still fires — at 45 % power
for a token amount of Mana — so a fight never degenerates into running away.
It is deliberately worse per point of Mana than a properly funded cast.

Each element can draw Mana back out of the world it is suited to: Water near
open water, Earth from terrain that connects with something, Fire from what it
sets alight, Air from deflection and speed. All of it runs through one metered
ceiling that sits *below* the cheapest primary rotation's cost per second, so
recovery is always a discount on the economy and never a replacement for it —
there is no infinite pool, no permanent zero-cost casting and no refund loop.

### The water combo

Water Whip is a short stream rather than a single bullet. It stays out for
about a third of a second, tracks where you look, and can damage the same
creature only every 0.12 s, so its damage is predictable. It leaves the target
**Wet** and **Slowed**.

Freeze on a soaked target locks it down for far longer than on a dry one, and
frozen bodies turn pale and glassy. Hitting frozen ice with Earth shatters it.
So the full chain is: **soak, freeze, break**.

### Pacing: how a fight starts, peaks and ends

The world is not a faucet. A director drives a cycle, and every phase of it is
a real state rather than a timer:

**explore → buildup → active → peak → resolve → recover → explore**

- **Explore** is quiet on purpose. The longer you go without finding anything,
  the more willing the director becomes to seed the next encounter, so you
  normally meet something within **30–60 seconds** — sooner near an uncleansed
  shrine, later out in open country. It is rising pressure, not a metronome.
- **Buildup** places the first creatures at a distance, with a couple of
  seconds before anything is allowed to engage.
- **Active** spends the encounter's threat budget; **peak** is the point at
  which reinforcements have stopped coming.
- **Reinforcements are finite**: a second, smaller budget, and they close
  entirely part-way through the fight. Nothing trickles in forever, and a
  Warden can only call a fixed number of waves.
- **Resolve → recover** guarantees a quiet spell of about nine seconds after a
  real fight, so the next thing you meet is something you walked into.

Two encounters never overlap, nothing spawns while you are below a quarter
health, and the world stays quiet for a beat whenever control comes back from
a story beat, a reward card, a chest or a world transition — and for longer
after a respawn than the respawn protection itself lasts.

### Where a creature is allowed to appear

A candidate point has to survive all of this before anything stands on it:

| Rule | Why |
| --- | --- |
| ≥ 28 m if you can actually see the spot | nothing pops into view |
| ≥ 16 m if it is in front but behind cover | you get to discover it |
| ≥ 26 m if it is outside your view | time to hear it and turn |
| ≤ 46 m | further away and it would never find you |
| solid, level-enough ground with 2.2 m of headroom | not inside the world |
| not in water, not in lava | unless it is built for the hazard |
| clear of props, boulders and shrines | nothing materialises on a structure |
| a neighbouring column it can walk to | not stranded on a pillar |

Terrain is destructible, so a creature can still end up walled into a pit it
cannot climb. Anything that spends twelve seconds chasing without getting
closer, or that ends up more than 95 m away, is quietly removed — without kill
credit, loot or encounter progress, so there is nothing there to farm.

### Attack tokens: how many things may swing at once

Tokens are spent by **weight**, not head count, because a ground slam and a
pot-shot are not the same amount of pressure in first person.

| | Weight |
| --- | --- |
| Ordinary melee swing | 1 |
| Heavy area or cone attack with a wide marker | 2 |
| Ranged volley | 1, from its own separate pool |

The budget is **2 early, 3 from depth 6, 4 from depth 15** — so early
encounters present one or two dangerous attackers and a late-game arena at
most four. Ranged fire draws on a pool of its own (1, then 2), which is what
stops a line of spitters from filling the air while something is already
mid-swing.

Some combinations are simply never allowed: two wide area attacks at once, an
off-screen shot while a heavy attack is committed, a heavy attack starting
behind you while shots are in the air, or more than one attack of any kind
coming from outside your view.

A creature refused a token does not stand still. It circles for a flank, holds
a ring at the edge of its own reach, presses in when it drifts wide and gives
ground when it is crowding you — it is still something to be careful about
backing into, it just is not swinging yet.

### Durability and damage

Creatures sit in four pacing bands, and the tuning is checked against real
attack speed, cooldowns and elemental resistance rather than by eye:

| Band | Examples | Time to kill with one element's primary |
| --- | --- | --- |
| Small | Crawler, Wisp, Thorn Spitter, Ember Burst | under 3 s |
| Standard | Root-Bound Hunter, Slinger, Magma Beast | under 6.5 s |
| Heavy | Brute, Stone Beast, Obsidian-Clad, Crystal-Clad | under 14 s |
| Guardian | Shrine Guardian | paced by phases |

Resistances are clamped to the range **0.55 – 1.8**. Fire really is the wrong
answer to an Obsidian-Clad and Water really is the right answer to a Magma
Beast — but no creature the campaign requires you to fight can shrug off an
entire element, so a focused adept is never left holding a build the game has
decided not to accept.

Incoming damage is capped separately from incoming health. Enemy **health**
climbs with depth up to ×2.6; enemy **damage** climbs far more gently, to
×1.6, and no single non-boss hit may ever take more than **32 %** of your
maximum health (a boss may take 45 %, because its wind-ups are longer). You
always have at least three hits of margin from full. A hit is followed by a
0.6-second window in which nothing else can land, so you never lose control to
a chain of them, and stacked burning ground is capped rather than additive.

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
fully restores health, refills Mana, clears cooldowns, saves the game, moves your respawn point,
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

## The story

The worlds were once held together by four **World Hearts**. A force called the **Hollow** fractured
the connections between them and left their keepers awake and wrong. You are a **Bound Wanderer**:
whatever the Hearts make when they are dying, woken with whichever single current still had the
strength to reach you.

The story is told in short, skippable beats — a brief opening, a two-line introduction to each
world, a moment before each guardian, a Heart restored, a world transition, a final reveal and a
post-game note — plus discoverable lore fragments. Nothing takes control during a fight: a beat that
would interrupt combat waits until it is safe.

It explains, in the fiction, exactly what the systems do: why the affinity is rolled and not chosen,
why the worlds are separated, why the creatures are corrupted, why your powers cross between worlds,
why a *new save* wakes a new affinity, and what happens after the last guardian falls.

---

## Worlds

Four structurally different worlds, generated from data rather than recoloured:

| World | Shape | Hazard | Feel |
| --- | --- | --- | --- |
| **Verdant Ruins** | Rolling forest, rivers, caves, overgrown ruins | — | The opening world |
| **Tidal Archipelago** | Islands over real depth, drowned ruins, air pockets | Drowning | Half of every arena is flooded |
| **Ember Caldera** | Lava basin, obsidian spires, elevated stone shelves | **Lava** | Stay on the high ground |
| **Frozen Expanse** | High snowfields over ice caverns, frozen lakes | Deep cold | Slippery, and you cannot see far |

Each world defines its own terrain shape, materials, fluid level, hazard, weather, lighting, fog,
ambience, enemy roster, structures, World Heart, guardian and exit portal.

Lava hurts the instant you touch it and leaves a short burn behind, but a brief accidental contact
is survivable, the shoreline is visibly marked, and the respawn resolver refuses to place you on a
ledge overhanging it. Water abilities crust lava over into temporary stone.

### Travelling between worlds

A restored World Heart opens the world's portal. Stepping through **saves first**, then carries
across: your affinity, Convergence state, every unlocked attack, every upgrade and chest reward,
maximum health and Mana, regeneration, movement and damage upgrades, the Ultimate unlock *and its
current charge*, ability mutations, inventory, permanent currency and story progress. Only the
terrain, the shrines and your current health and Mana are new.

Finishing the last world opens the **post-game**: the ending plays, you keep playing with the exact
build you made, and the final portal offers **New Game Plus inside the same save**, which resets the
worlds and nothing else. The affinity is rerolled **only** when you deliberately create a new save.

---


### Finishing a world: the World Beacon

Restore all four shrines and the **World Beacon** lights. It is a grounded
stone plinth under a column of light ninety metres tall — visible across the
whole world — and it is the deliberate way onward.

- It appears beside the shrine you finished last, or at the centre of the world
  if that ground is unsuitable. Placement is validated for level, dry, open
  ground with headroom, well clear of water, lava, props and cliffs, and it is
  deterministic, so it stands in the same place every time you load.
- It is marked on the **compass** with its distance in metres, and named in the
  **objective line**. Before it lights, the objective shows your progress
  toward it (`2/4 shrines · the Beacon lights at 4`).
- Terrain deformation cannot bury or remove it: the ground around it is
  protected. Only the plinth is solid; the beam is light.
- Walk up and **hold `E`** to travel. It is a hold, not a tap, so brushing past
  it with a finger on the interact key never takes the world away.

In the last world the Beacon leads to the ending instead, and after the
campaign it offers New Game Plus — with an explicit confirmation first.

**Everything comes with you:** affinity, Convergence state, active element,
every ability, every upgrade, chest rewards, tradeoffs, Mana upgrades, the
Ultimate unlock *and its charge*, maximum health, inventory, permanent
currency, story progress, completed worlds, New Game Plus count and world mode.
Travelling saves before it leaves and again only once the destination has
successfully built; if either step fails, the previous save is restored and you
stay where you are with a readable message rather than a black screen.

A save that finished a world before the Beacon existed lights one the moment it
loads. Nothing is reset, no guardian has to be fought again, and no reward,
chest or affinity is rerolled — the Beacon is reconstructed from the shrine
flags the save already had, so there is no migration.

### First-world pacing

Verdant Ruins teaches, but it is no longer a five-minute world. Expect roughly
**15–25 minutes** for an experienced player and **20–35** for a new one. The
increase is in resistance, not in padding: a fuller encounter budget, an elite
rate that actually produces an escalation, and a Rootwarden durable enough to
reach its second and third phases. There is no minimum timer anywhere.

### How the four worlds differ mechanically

They were always shaped differently - real islands, a real lava basin, a real
snowfield. They now *fight* differently too. Each world declares how it wants to
be fought, and the spawn director composes encounters to match rather than
drawing from the roster at random:

| World | Intent | Ranged share | Heavy share | Elites | Hazard |
| --- | --- | --- | --- | --- | --- |
| **Verdant Ruins** | Teaches: readable, separable roles | 30 % | 35 % | ×0.6 | none |
| **Tidal Archipelago** | Movement and resources: ambush, support | 40 % | 40 % | ×0.9 | none |
| **Ember Caldera** | Positional pressure: armour, fire, lava | 50 % | 55 % | ×1.15 | lava |
| **Frozen Expanse** | Everything at once, half-seen | 45 % | 50 % | ×1.35 | deep cold |

The **ranged share** is the important one: three archers is a different fight
from three brawlers whatever their health says, so the cap on how much of an
encounter's threat budget may shoot at you is the single largest difficulty
control in the game. Enemy *health* does not change across the base campaign at
all — the curve is entirely composition, elites, budget and one extra
simultaneous attacker in the last world.

### Hazards

**Lava** (Ember Caldera) costs 7 health per half-second of contact and leaves
you burning for four seconds afterwards. A brush across a corner is survivable;
standing in it is not. A 2.5 m warning band marks the edge.

**Deep cold** (Frozen Expanse) drains while you are out in the open with the
blizzard blowing, and stops entirely under an overhang or inside a cavern. It is
a slow bite — over fifteen seconds from full health at full exposure — because
the answer is to move toward cover, not to out-heal the weather.

Each world also caps how much ground a single attack may reshape, so terrain
play cannot flatten a lava basin's shelves or an ice bridge.

### New Game Plus

A cycle keeps everything that defines you — affinity, Convergence state, build,
chest rewards, Ultimate unlock, inventory, currency, story seen, world mode —
and resets only the worlds. Difficulty rises through **combination**: more
elites, a larger share of the budget allowed to shoot or to wear armour, one
more simultaneous attacker at the top. Enemy health rises by at most 75 % across
*all five* scaling cycles, and everything stops scaling at cycle five, so a
later cycle is a harder game rather than an impossible one.


## Swimming and oxygen

Your head under water starts an oxygen meter. It drains, the screen and audio change, and at zero
you take periodic drowning damage — never an instant death, and always with time to reach the
surface. Air pockets inside drowned ruins count as breathing. Water adepts drain oxygen ~40 % more
slowly and swim faster, but no element gets unlimited air. Loading a save never drops you straight
into a drowning: the stored oxygen is clamped and the safe-placement resolver refuses a submerged
spot.

---

## Chests

Chests are scattered through every world at five rarities — Common, Uncommon, Rare, Epic and
Legendary — with the rarity fixed by the world seed, so a chest looks and rewards the same every
time you load. Opening one plays an animation and a distinct sound, then shows a card stating the
rarity, the exact numbers, whether the effect is **permanent for this save** or **temporary**, and
any downside.

A chest can never open into nothing: if the permanent pool for its rarity is exhausted it falls back
to a timed blessing, and failing that to recovery, which always applies. Permanent gains are written
to storage before you dismiss the card, and a chest can only be taken once — its lid stays open.

**Double Damage** is a Legendary chest reward: damage ×2, maximum Mana −25 %, unique, and mutually
exclusive with Glass Cannon so the two multipliers can never be stacked.

---

## Rewards and growth

### When a card appears

A selection card follows an **accomplishment**, not a kill count. Clearing a real
encounter, defeating an elite, finishing an objective, finding a good chest and
putting down a guardian each pay credit toward the next choice:

| Accomplishment | Credit |
| --- | --- |
| Encounter cleared | 1 |
| Hidden discovery / rare chest | 1 |
| Elite defeated | 2 |
| Objective completed | 2 |
| Guardian defeated | 4 (offered immediately) |
| World boss defeated | 6 (offered immediately) |

Three credits opens a screen, and a minimum gap of 75 seconds stops a run of
quick wins from becoming a run of menus. If five minutes pass with any credit
banked, the card comes anyway — so a careful player is never left out. The first
three cards arrive on a shorter leash, so a build direction can form inside the
first world. A card never opens while something is still attacking you; the
credit simply waits.

### Rarity and what it buys

Higher rarity buys **mechanics**, not bigger percentages. Every card in the pool
is priced against a budget for its rarity: a ceiling on how much raw stat it may
carry, and — from Rare upward — a requirement that it either switches on a
behaviour or spends a genuinely rarity-sized effect. Every Legendary changes how
an ability works.

Nothing a card promises is decorative: every behaviour tag in the pool is
implemented and the test suite refuses to let an unimplemented one ship.

A run of screens with nothing of Rare or better quietly improves the odds on the
next one, up to a cap, and resets the moment a Rare appears. It softens bad luck
without ever becoming a guarantee.

### Stacking

Modifiers combine additively (health, crit chance, Mana return) or
multiplicatively (damage, cooldowns, area, status duration). Multiplicative
damage had no ceiling at all: five stacks of Honed Focus with Overcharge and one
of the two doubling rewards reached ×5.3, and critical damage another ×5.4 on
top. Damage is now capped at **×4**, single-element damage at **×2** and critical
damage at **×4** — high enough that a deliberate power build still feels like
one, and the pause screen names every ceiling you have reached rather than
quietly applying less than your cards promised.

## Reward cards and tradeoffs

Post-encounter cards show the reward's name, element sigil, rarity, exact numeric effects (gains in
green, penalties in red with a warning symbol), element compatibility, stack count, synergy, how
long it lasts, and a **before/after preview** of every stat it moves. Pick with the mouse, the
number keys, or the arrow keys and Enter.

Tradeoff cards are real decisions — "Damage ×2, but maximum health −30 %", "Cooldowns −30 %, but
ability Mana costs +25 %", "Ultimate damage +75 %, but the meter fills 35 % more slowly". Penalties
are never hidden, incompatible pairs are never offered together, and a stack of penalties can never
push health, Mana, regeneration, range, sprint speed or Ultimate charge below a safe minimum.

---

## Build version

The running build is shown in the bottom-right corner of the screen, on the
title, in play, in the pause menu, on the Continue screen and on the error
screen:

```text
v1.0.1 • edc3c99
```

Hovering it — or reading it with a screen reader — gives the longer form:

```text
Built 2026-08-12 14:30 UTC • production
```

The version is **compiled into the JavaScript bundle** by Vite's `define` at
build time, never fetched. That is deliberate: a version read from a separate
file could be served from a different cache than the code that read it, which
is exactly the confusion the label exists to end. After a deploy, comparing the
label with the commit tells you whether the new build is live.

`package.json` is the source of truth for the semantic version. The commit
comes from the CI provider when one is present (`COMMIT_REF`,
`VERCEL_GIT_COMMIT_SHA`, `GITHUB_SHA`, `CF_PAGES_COMMIT_SHA`), otherwise from
`git rev-parse`. A local `npm run dev` build reads `v1.0.1 • dev`, which says
plainly that it is not a deployed bundle. Only the short commit is ever shown.

## Save data

Everything lives in your browser's LocalStorage under two keys:

- `elemental-frontier/world` — the world
- `elemental-frontier/settings` — audio, sensitivity, FOV and all graphics settings

The world save (**version 5**) holds the save-data version, world seed, elemental affinity, the
active element for Convergence, the **world mode**, per-shrine cleansed / guardian / mote state, your
position and view angles, respawn point and its world, health, Mana, blessings earned, carried
terrain materials, healing items, the **terrain brush journal**, which props and chests you have
opened, playtime and tutorial state.

Version 5 adds the persistent build layer: the current world, completed worlds and World Heart
progress, every upgrade and chest reward, the Ultimate unlock and its current charge, running timed
blessings, oxygen, story progress, the post-game flag and the New Game Plus counter.

Autosave happens periodically (every 20 s), when you cleanse a shrine, gather a mote, loot a cache,
**open a chest**, **take a reward**, **defeat a guardian**, rest, pause, change a setting, die,
switch world mode, **before leaving a world and again after arriving in the next one**, and before
returning to the title screen.

Only a deliberate **New World** creates a new progression, clears the build and rerolls the
affinity — and it asks for confirmation first. A world transition, a death, the ending and Continue
are all explicitly *not* new games.

### Migration

Migration is versioned and additive: every field added in a newer version has a safe default, so an
older save loads with everything it already had intact.

- A **version 4** save keeps its seed, affinity, terrain, build, shrines, meta progression and
  statistics, and simply starts the new persistent layer from zero. A save that had already cleansed
  a shrine keeps its Ultimate unlocked.
- Stored oxygen is clamped on load so a save can never drop you straight into a drowning death.
- Unknown world ids, story beats, blessings and upgrade ids are discarded rather than failing the
  load.

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
    │   ├── Player.ts           movement, capsule collision, vitals, swimming
    │   ├── collision.ts        swept capsule, depenetration, step-up, slope limit (pure)
    │   ├── respawn.ts          validated safe-respawn resolver (pure)
    │   ├── oxygen.ts           oxygen, drowning and swimming rules (pure)
    │   └── inventory.ts        terrain materials, healing items, quick-heal choice
    ├── elements/
    │   ├── affinity.ts         the weighted affinity roll and its rules
    │   ├── elements.ts         element, ability and build-path definitions (data)
    │   └── abilities.ts        runtime behaviour of all sixteen abilities
    ├── progression/
    │   ├── upgrades.ts         upgrades, tradeoffs, chest rewards, stat formatting
    │   ├── rewards.ts          reward rolling and card previews
    │   ├── chests.ts           chest rarity, contents and blessings
    │   ├── buffs.ts            timed blessings and modifier combination
    │   ├── ultimate.ts         the Ultimate charge meter
    │   ├── cadence.ts          when a selection card is worth showing (pure)
    │   └── mana.ts             the Mana economy
    ├── combat/
    │   ├── Enemies.ts          creature bodies, AI, damage, drops, peaceful mode
    │   ├── enemyTypes.ts       archetypes, tiers, body plans, weak points, elites (data)
    │   ├── combatConfig.ts     the central tuning table every other file reads (data)
    │   ├── CombatDirector.ts   weighted attack tokens and telegraph fairness (pure)
    │   ├── encounter.ts        the encounter pacing cycle and its budgets (pure)
    │   ├── spawnRules.ts       spawn placement validation and stuck recovery (pure)
    │   ├── CollisionDebug.ts   F10 collision visualiser (development only)
    │   └── Projectiles.ts      pooled projectiles and deflection
    ├── fx/
    │   └── Particles.ts        pooled GPU particle system
    ├── audio/
    │   └── AudioEngine.ts      every sound, synthesised with the Web Audio API
    ├── world/
    │   ├── worlds.ts           the four world definitions (data)
    │   ├── progression.ts      world difficulty profiles, guardians, NG+ (pure)
    │   ├── beacon.ts           World Beacon placement, mode and hold (pure)
    │   ├── Obstacles.ts        collision volumes for everything that is not terrain
    │   └── deformation.ts      combat terrain deformation rules and ground zones
    ├── save/
    │   └── saveData.ts         save schema, validation, v2-v4 migration, settings
    ├── ui/
    │   └── UI.ts               screens, HUD, compass, satchel, tutorial, overlays
    └── game/
        ├── Game.ts             state machine, main loop, system wiring
        ├── story.ts            the World Hearts narrative beats (data)
        ├── Healing.ts          regeneration, food, potions, resting (pure)
        └── Tutorial.ts         adaptive tutorial steps
```

---

## Tests

```bash
npm test
```

**411 tests across ten suites**, all pure logic with no WebGL requirement:

- **Respawn** — the floor search, every rejection rule (air, terrain, steepness, clearance, water,
  scenery, creatures, hazards, world bounds), the spiral search, the validated fallback, the
  world scan, and recovery after terrain deformation.
- **Collision** — capsule sampling, depenetration and sliding, swept motion refusing to tunnel,
  step-up inside and outside the step height, slope limits, ground probing, standing on obstacles,
  the obstacle registry, and collision updating immediately after a wall is raised.
- **Systems** — chest generation never returning nothing, Double Damage's rarity, uniqueness and
  downside, every tradeoff showing both sides, safe minimums holding under a pile of penalties,
  four actives per element, Ultimate charge sources and anti-spam rules, Mana regeneration and the
  fallback cast, oxygen drain, recovery and drowning cadence, elemental terrain interactions, story
  sequencing, world distinctness and the redesigned monsters.
- **Save** — version 4 → 5 migration keeping everything and defaulting the new layer safely.
- **Worlds** — world distinctness in terrain, fluid, hazard and roster; the difficulty curve
  climbing through composition rather than health; per-world ranged and heavy shares actually
  holding over many composed encounters; guardian phases, cadence and telegraph readability;
  New Game Plus caps; transition persistence and rollback; Peaceful Mode refusing every spawn in
  every world at every cycle; and save defaults for missing world progress.
- **Rewards** — cadence gates and the 2-5 minute target, rarity distribution over thousands of
  seeded rolls, unlucky-streak protection, every card priced against its rarity budget, every
  promised behaviour actually implemented, no vague card copy, tradeoff costs and safe minimums,
  Double Damage's uniqueness and exclusions, stacking ceilings, previews matching the real
  calculation path, per-element build directions, Convergence compatibility, deterministic chest
  contents, exhausted-pool fallbacks, and build persistence across transitions and death.
- **Balance** — deterministic time-to-kill for every creature against every element, per-hit
  incoming-damage ceilings, cooldown and cost ordering, Mana regeneration and refund throttling,
  cost-reduction caps, Ultimate charge rate limits and per-source caps, weighted attack-token
  budgets, the whole encounter cycle driven forward in simulation, spawn placement validation,
  Peaceful Mode refusing every spawn, and the save schema staying exactly where it was.


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
