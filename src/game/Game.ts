/**
 * Game orchestration: state machine, main loop, and the wiring between every
 * subsystem (smooth terrain, player, abilities, enemies, shrines, props,
 * healing, UI, audio, saves).
 */

import * as THREE from 'three';
import { Renderer } from '../render/Renderer';
import { Input } from '../core/Input';
import { AudioEngine } from '../audio/AudioEngine';
import { World } from '../world/World';
import { ShrineManager } from '../world/Shrines';
import { Flora } from '../world/Flora';
import { Props } from '../world/Props';
import { Water } from '../world/Water';
import { Particles } from '../fx/Particles';
import { Projectiles, type Projectile } from '../combat/Projectiles';
import { EnemyManager, type Enemy } from '../combat/Enemies';
import { bodyCapsule, sweptSphereVsCapsule, type Capsule, type Vec3 } from '../combat/hitVolumes';
import { Player } from '../player/Player';
import {
  CONSUMABLES, CONSUMABLE_ORDER, Inventory, STARTING_CONSUMABLES, STARTING_MATERIALS,
  chooseHealingItem, type ConsumableId,
} from '../player/inventory';
import { AbilitySystem, type AbilitySlot } from '../elements/abilities';
import { UI, type CrosshairState, type HudState } from '../ui/UI';
import { ELEMENTS, ELEMENT_ORDER, affinityPresentation } from '../elements/elements';
import {
  isConvergence, resolveActiveElement, rollAffinity,
  type AffinityId, type ElementId,
} from '../elements/affinity';
import {
  DEFAULT_SETTINGS, applyQualityPreset, createSave, deleteSave, loadSave, loadSettings,
  opsFromSave, writeSave, writeSettings,
  type QualityPreset, type SaveData, type Settings,
} from '../save/saveData';
import {
  MOTES_PER_SHRINE, SHRINE_SITES, SHRINE_UPGRADES, accumulateUpgrades, allShrinesCleansed,
  type WorldMode,
} from '../world/shrineData';
import { Mat, materialDef, type MaterialId } from '../world/materials';
import { SEA_LEVEL, WORLD_CENTER, inWorld } from '../world/coords';
import { serialiseOps, clampBrush, type TerrainOp } from '../world/terrainEdits';
import { randomSeed } from '../core/rng';
import { Decals } from '../fx/Decals';
import { Weather, weatherAt } from '../fx/Weather';
import { Telegraphs } from '../fx/Telegraphs';
import { RunState } from '../progression/RunState';
import { RARITY_COLORS } from '../progression/upgrades';
import { relativeBearing } from '../combat/CombatDirector';
import { CombatDebug, type DebugFrame } from '../combat/CombatDebug';
import { abilityCombat } from '../combat/combatConfig';
import type { EliteId, EnemyKind } from '../combat/enemyTypes';
import { ENEMY_TYPES } from '../combat/enemyTypes';
import { STATUSES, type StatusId } from '../combat/status';
import { BREATH_SECONDS } from '../player/Player';
import {
  REST_DURATION, canRest, clearEffects, consume, createHealingState, notifyDamaged,
  notifyDealtDamage, tickHealing, tickRest, type CombatContext, type HealingState,
} from './Healing';
import { buildTutorial, createTracker, tutorialTitle, type TutorialStepDef, type TutorialTracker } from './Tutorial';

type GameState =
  | 'boot' | 'title' | 'newworld' | 'settings' | 'loading' | 'reveal'
  | 'playing' | 'paused' | 'dead' | 'upgrade' | 'victory' | 'confirm' | 'satchel' | 'reward';

const REACH = 7;
const ELEMENT_SWITCH_COOLDOWN = 1.2;
const CLEANSE_DURATION = 1.9;
const AUTOSAVE_INTERVAL = 20;
const DAY_LENGTH = 720;
/** Terrain strokes per second while the dig button is held. */
const BRUSH_RATE = 9;

const _v1 = new THREE.Vector3();
const _contact = new THREE.Vector3();
const _sweepA: Vec3 = { x: 0, y: 0, z: 0 };
const _sweepB: Vec3 = { x: 0, y: 0, z: 0 };
const _v2 = new THREE.Vector3();
const _tintColor = new THREE.Color();
const _enemyScratch: Enemy[] = [];
const _statusScratch: { id: StatusId; stacks: number }[] = [];

export class Game {
  private renderer: Renderer;
  private ui = new UI();
  private audio = new AudioEngine();
  private input: Input;
  private world = new World();
  private flora = new Flora();
  private props = new Props();
  private water = new Water();
  private particles = new Particles();
  private projectiles: Projectiles;
  private enemies: EnemyManager;
  private shrines: ShrineManager;
  private player: Player;
  private inventory = new Inventory();
  private abilities: AbilitySystem;
  private healing: HealingState = createHealingState();
  private decals = new Decals();
  private weather = new Weather();
  private telegraphs = new Telegraphs();
  private run = new RunState();
  /** Short freeze applied on weighty impacts. */
  private hitStopTimer = 0;
  /** Pooled short-lived lights for elemental impacts. */
  private pulseLights: { light: THREE.PointLight; life: number }[] = [];
  private maxPulseLights = 5;
  /** Storm phase for the ambient weather cycle. */
  private stormPhase = 0;

  private settings: Settings;
  private save: SaveData | null = null;
  private state: GameState = 'boot';
  private stateBeforeSettings: GameState = 'title';
  private stateBeforeConfirm: GameState = 'title';

  private affinity: AffinityId = 'air';
  private activeElement: ElementId = 'air';
  private worldMode: WorldMode = 'normal';
  private switchTimer = 0;

  private loadIterator: Generator<{ progress: number; note: string }, void, void> | null = null;
  private pendingIsNew = false;

  private lastTime = 0;
  private accumulatedPlaytime = 0;
  private autosaveTimer = AUTOSAVE_INTERVAL;
  private timeOfDay = 0.34;
  private frameCount = 0;
  private fpsTimer = 0;
  private running = false;
  private fpsVisible = false;
  private viewportW = 0;
  private viewportH = 0;

  // --- terrain brush
  private brushRadius = 3;
  private brushTimer = 0;
  private terrainMoved = 0;

  private cleanseProgress = 0;
  private cleanseTarget = -1;
  private restFadeTimer = 0;

  private tracker: TutorialTracker = createTracker();
  private tutorialSteps: TutorialStepDef[] = [];
  private tutorialActive = false;
  private lastPlayerPos = new THREE.Vector3();

  private edgeWarned = 0;
  private stuckTimer = 0;

  /** Development-only combat visualiser. Disabled until F9 is pressed. */
  private readonly combatDebug = new CombatDebug();
  private readonly debugBoxes: { id: number; capsule: Capsule; visible: boolean }[] = [];
  private readonly debugVolumes: Capsule[] = [];
  private readonly debugPaths: { from: Vec3; to: Vec3 }[] = [];
  private debugFrame: DebugFrame | null = null;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.settings = loadSettings(window.localStorage);
    this.renderer = new Renderer(canvas);
    this.input = new Input(canvas);
    this.player = new Player(this.world);

    this.projectiles = new Projectiles({
      onImpact: (p, point, entity) => this.onProjectileImpact(p, point, entity),
      onEntitySweep: (p, from, to) => this.onProjectileSweep(p, from, to),
      onTrail: (p) => this.onProjectileTrail(p),
    });

    this.enemies = new EnemyManager({
      world: this.world,
      particles: this.particles,
      projectiles: this.projectiles,
      audio: this.audio,
      camera: this.renderer.camera,
      getPlayerPosition: () => _v1.copy(this.player.position).setY(this.player.position.y + 1),
      isPlayerAlive: () => this.player.alive,
      damagePlayer: (amount, from, knockback) => this.damagePlayer(amount, from, knockback),
      onGuardianDefeated: (index) => this.onGuardianDefeated(index),
      onEnergyPickup: (amount) => this.player.addEnergy(amount),
      getPlayerForward: () => this.player.getForward(_v2),
      telegraph: (x, y, z, radius, seconds, color) =>
        this.telegraphs.add(x, y, z, radius, seconds, color),
      offscreenWarning: (fromX, fromZ) => this.showDamageDirection(fromX, fromZ, true),
      onEnemyKilled: (kind, elites) => this.onEnemyKilled(kind, elites),
      difficulty: () => this.run.difficulty,
    });

    this.shrines = new ShrineManager(this.world, this.particles);

    this.abilities = new AbilitySystem({
      player: this.player,
      world: this.world,
      enemies: this.enemies,
      projectiles: this.projectiles,
      particles: this.particles,
      audio: this.audio,
      decals: this.decals,
      build: this.run.build,
      affinityBonus: () => this.run.affinityBonus,
      flash: (color, strength) => this.ui.elementFlash(color, strength),
      hitMarker: (crit) => this.ui.hitMarker(crit),
      confirmHit: (outcome) => this.ui.hitConfirm(outcome),
      debug: (event) => {
        if (!this.combatDebug.enabled) return;
        const parts = [event.kind, event.ability];
        if (event.enemyId !== undefined) parts.push(`#${event.enemyId}`);
        if (event.damage !== undefined) parts.push(`dmg ${event.damage.toFixed(1)}`);
        if (event.status) parts.push(event.status);
        if (event.reason) parts.push(`(${event.reason})`);
        this.combatDebug.push(parts.join(' '));
      },
      toast: (message, tone) => this.ui.toast(message, tone ?? 'plain', 1.8),
      dealtDamage: () => notifyDealtDamage(this.healing),
      hitStop: (seconds) => { this.hitStopTimer = Math.max(this.hitStopTimer, seconds); },
      pulseLight: (x, y, z, color, intensity, seconds) =>
        this.addPulseLight(x, y, z, color, intensity, seconds),
      lifesteal: (amount) => this.player.heal(amount),
    });

    this.renderer.scene.add(this.combatDebug.group);
    this.renderer.scene.add(this.world.group);
    this.renderer.scene.add(this.flora.group);
    this.renderer.scene.add(this.props.group);
    this.renderer.scene.add(this.water.mesh);
    this.renderer.scene.add(this.particles.group);
    this.renderer.scene.add(this.projectiles.group);
    this.renderer.scene.add(this.enemies.group);
    this.renderer.scene.add(this.shrines.group);
    this.renderer.scene.add(this.decals.mesh);
    this.renderer.scene.add(this.telegraphs.mesh);
    this.renderer.scene.add(this.weather.points);

    this.player.onLand = (impact) => {
      if (impact > 6) this.audio.play('land', 120);
    };
    this.player.onSplash = () => this.audio.play('splash', 200);
    this.player.onDrown = () => {
      notifyDamaged(this.healing);
      this.audio.play('hurt', 400);
      this.ui.damageFlash(0.5);
      this.ui.toast('You are drowning', 'bad', 1.4);
    };
  }

  // ---------------------------------------------------------------- boot

  start(): void {
    this.ui.bind({
      onContinue: () => this.continueWorld(),
      onNewWorld: () => this.openNewWorld(),
      onCreateWorld: (mode) => this.createNewWorld(mode),
      onDeleteSave: () => this.requestDeleteSave(),
      onOpenSettings: () => this.openSettings(),
      onCloseSettings: () => this.closeSettings(),
      onResetSettings: () => this.resetSettings(),
      onSettingChange: (patch) => this.applySettings(patch),
      onQualityPreset: (preset) => this.setQualityPreset(preset),
      onResume: () => this.resume(),
      onQuitToTitle: () => this.quitToTitle(),
      onReplayTutorial: () => this.replayTutorial(),
      onToggleWorldMode: () => this.requestModeSwitch(),
      onRespawn: () => this.respawn(),
      onRevealContinue: () => this.finishReveal(),
      onUpgradeContinue: () => this.finishUpgrade(),
      onVictoryContinue: () => this.continueAfterVictory(),
      onVictoryNewWorld: () => this.openNewWorld(),
      onCancelConfirm: () => this.cancelConfirm(),
      onUseItem: (id) => this.useItem(id, true),
      onCloseSatchel: () => this.closeSatchel(),
      onTakeReward: (id) => this.takeReward(id),
      onSkipReward: () => this.skipReward(),
      onAnyInteraction: () => this.audio.unlock(),
    });
    this.ui.onTutorialDismissed = () => {
      this.tutorialActive = false;
      if (this.save) {
        this.save.tutorialDone = true;
        this.persist();
      }
    };

    this.input.onPointerLockLost = () => {
      if (this.state === 'playing') this.pause();
    };
    this.input.onKeyDown = (code) => this.handleGlobalKey(code);
    this.input.attach();
    this.input.sensitivity = this.settings.sensitivity;

    this.canvas.addEventListener('mousedown', () => {
      this.audio.unlock();
      if (this.state === 'playing' && !this.input.locked) this.input.requestLock();
    });

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('beforeunload', () => {
      if (this.save && (this.state === 'playing' || this.state === 'paused')) this.persist();
    });

    this.applyRendererSettings();
    this.ui.syncSettings(this.settings);
    this.ui.setNewWorldMode('normal');
    this.refreshTitle();
    this.setState('title');

    this.running = true;
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.frame(t));
  }

  private refreshTitle(): void {
    const result = loadSave(window.localStorage);
    if (result.ok && result.data) {
      this.save = result.data;
      this.ui.setContinueInfo(result.data);
      if (result.terrainReset) {
        this.ui.toast('Older world upgraded to smooth terrain - previous block edits could not be converted', 'warn', 6);
      } else if (result.migrated) {
        this.ui.toast('Save data was repaired and kept', 'warn', 3.4);
      }
    } else {
      this.save = null;
      this.ui.setContinueInfo(null);
      if (result.reason && result.reason !== 'empty') {
        this.ui.toast('Stored world data was unreadable - start a new world', 'bad', 4.5);
      }
    }
  }

  private setState(state: GameState): void {
    this.state = state;
    switch (state) {
      case 'title': this.ui.showScreen('title'); break;
      case 'newworld': this.ui.showScreen('newworld'); break;
      case 'settings': this.ui.showScreen('settings'); break;
      case 'loading': this.ui.showScreen('loading'); break;
      case 'reveal': this.ui.showScreen('reveal'); break;
      case 'paused': this.ui.showScreen('pause'); break;
      case 'playing': this.ui.showScreen('none'); break;
      default: break; // death / upgrade / victory / confirm / satchel show themselves
    }
  }

  // ------------------------------------------------------------- setting

  private applySettings(patch: Partial<Settings>): void {
    Object.assign(this.settings, patch);
    this.input.sensitivity = this.settings.sensitivity;
    this.applyRendererSettings();
    writeSettings(window.localStorage, this.settings);
  }

  private setQualityPreset(preset: QualityPreset): void {
    this.settings = applyQualityPreset(this.settings, preset);
    this.ui.syncSettings(this.settings);
    this.applyRendererSettings();
    writeSettings(window.localStorage, this.settings);
    this.audio.play('ui-click');
    this.ui.toast(`${preset[0]!.toUpperCase()}${preset.slice(1)} quality applied`, 'good', 1.8);
  }

  private applyRendererSettings(): void {
    this.renderer.setFov(this.settings.fov);
    this.renderer.setRenderDistance(this.settings.renderDistance);
    this.renderer.setShadows(this.settings.shadows, this.settings.shadowQuality);
    this.renderer.setPostProcessing(this.settings.postProcessing);
    this.renderer.setAntialias(this.settings.antialias);
    this.world.setShadowCasting(this.settings.shadows);
    this.world.setMeshBudget(4 * this.settings.terrainDetail);
    this.particles.setDensity(this.settings.particleDensity);
    this.decals.setBudget(24 + this.settings.particleDensity * 48);
    this.weather.setDensityScale(this.settings.particleDensity);
    this.maxPulseLights = this.settings.postProcessing ? 5 : 2;
    this.projectiles.setMaxLights(this.settings.postProcessing ? 4 : 2);
    this.audio.setVolumes({
      master: this.settings.masterVolume,
      sfx: this.settings.sfxVolume,
      ambience: this.settings.ambienceVolume,
      muted: this.settings.muted,
    });
  }

  private resetSettings(): void {
    this.settings = { ...DEFAULT_SETTINGS };
    this.ui.syncSettings(this.settings);
    this.applySettings({});
    this.audio.play('ui-back');
  }

  private openSettings(): void {
    if (this.state !== 'settings') this.stateBeforeSettings = this.state === 'paused' ? 'paused' : 'title';
    this.ui.syncSettings(this.settings);
    this.audio.play('ui-click');
    this.setState('settings');
  }

  private closeSettings(): void {
    this.audio.play('ui-back');
    writeSettings(window.localStorage, this.settings);
    if (this.save && this.stateBeforeSettings === 'paused') this.persist();
    this.setState(this.stateBeforeSettings);
  }

  // ------------------------------------------------------ world lifecycle

  private openNewWorld(): void {
    this.audio.play('ui-click');
    this.stateBeforeConfirm = this.state === 'victory' ? 'victory' : 'title';
    this.ui.setNewWorldMode(this.save?.worldMode ?? 'normal');
    this.setState('newworld');
  }

  private createNewWorld(mode: WorldMode): void {
    if (this.save) {
      this.stateBeforeConfirm = 'newworld';
      this.ui.askConfirm(
        'Overwrite your world?',
        'Creating a new world permanently replaces your saved world, its seed, its terrain and its elemental affinity. A new affinity will be rolled.',
        () => this.doCreateWorld(mode),
        'Create world',
      );
      this.setState('confirm');
      return;
    }
    this.doCreateWorld(mode);
  }

  private doCreateWorld(mode: WorldMode): void {
    // The one and only place an affinity is ever rolled.
    const seed = randomSeed();
    const affinity = rollAffinity();
    const fresh = createSave(
      seed, affinity, mode,
      [WORLD_CENTER, 40, WORLD_CENTER],
      { ...STARTING_MATERIALS } as Record<number, number>,
      { ...STARTING_CONSUMABLES },
    );
    writeSave(window.localStorage, fresh);
    this.pendingIsNew = true;
    this.beginLoad(fresh);
  }

  private requestDeleteSave(): void {
    this.audio.play('ui-click');
    this.stateBeforeConfirm = 'title';
    this.ui.askConfirm(
      'Delete saved world?',
      'This erases the stored world, its seed, its terrain edits and its affinity. Settings are kept.',
      () => {
        deleteSave(window.localStorage);
        this.save = null;
        this.ui.setContinueInfo(null);
        this.ui.toast('Saved world deleted', 'warn');
        this.audio.play('ui-back');
        this.setState('title');
      },
      'Delete',
    );
    this.setState('confirm');
  }

  private continueWorld(): void {
    this.audio.play('ui-click');
    const result = loadSave(window.localStorage);
    if (!result.ok || !result.data) {
      this.ui.toast('That save could not be read - create a new world', 'bad', 4);
      this.openNewWorld();
      return;
    }
    this.pendingIsNew = false;
    this.beginLoad(result.data);
  }

  private beginLoad(save: SaveData): void {
    this.setState('loading');
    this.ui.setLoading(0, 'Sculpting the Verdance…');
    this.projectiles.clear();
    this.enemies.clear();
    this.particles.clear();
    this.loadIterator = this.loadSequence(save);
  }

  private *loadSequence(save: SaveData): Generator<{ progress: number; note: string }, void, void> {
    for (const p of this.world.generate(save.seed, save.shrines)) {
      yield { progress: p, note: 'Raising hills, carving caves and basins…' };
    }
    yield { progress: 0.58, note: 'Replaying your excavations…' };
    this.world.applyJournal(opsFromSave(save));
    for (const p of this.world.buildAllChunks()) {
      yield { progress: 0.6 + p * 0.32, note: 'Building the smooth terrain surface…' };
    }
    yield { progress: 0.94, note: 'Planting forests and lighting campfires…' };
    this.world.resolveSpawn(WORLD_CENTER, WORLD_CENTER);
    this.flora.build(this.world, save.seed, 1);
    this.props.build(this.world, save.seed, save.lootedProps);
    yield { progress: 0.98, note: 'Waking the shrines…' };
    this.finishLoad(save);
  }

  private finishLoad(save: SaveData): void {
    this.affinity = save.affinity;
    this.activeElement = resolveActiveElement(save.affinity, save.activeElement);
    this.worldMode = save.worldMode;
    this.player.activeElement = this.activeElement;

    this.shrines.build(save.shrines, save.guardians, save.motes, save.worldMode);
    this.enemies.setCleansed(save.shrines);
    // Force the manager into the right mode without triggering a transition.
    this.enemies.setMode(save.worldMode === 'peaceful' ? 'peaceful' : 'normal');
    this.shrines.setMode(save.worldMode);

    const stats = accumulateUpgrades(save.upgrades, isConvergence(save.affinity));
    this.player.applyStats(stats, false);
    if (save.health >= 0) this.player.health = Math.min(stats.maxHealth, Math.max(1, save.health));
    if (save.energy >= 0) this.player.energy = Math.min(stats.maxEnergy, Math.max(0, save.energy));
    this.player.alive = true;
    this.healing = createHealingState();

    this.applyBuildToPlayer();
    this.inventory.loadMaterials(save.materials);
    this.inventory.loadConsumables(save.items);
    if (this.pendingIsNew) {
      this.inventory.loadMaterials({ ...STARTING_MATERIALS } as Record<number, number>);
      this.inventory.loadConsumables({ ...STARTING_CONSUMABLES });
    }

    const spawn = this.world.spawn;
    let px = save.position[0];
    let py = save.position[1];
    let pz = save.position[2];
    if (!inWorld(px, py, pz) || this.pendingIsNew) {
      px = spawn.x; py = spawn.y; pz = spawn.z;
    }
    this.player.teleport(px, py, pz);
    if (this.player.isStuck()) {
      this.player.teleport(spawn.x, spawn.y, spawn.z);
      this.player.unstick();
    }
    this.player.yaw = save.yaw;
    this.player.pitch = save.pitch;
    this.lastPlayerPos.copy(this.player.position);

    this.abilities.reset();
    // ---- run layer
    this.run.load({
      build: save.build, meta: save.meta, depth: save.depth,
      encounters: save.encounters, worldTheme: save.worldTheme,
      runStats: save.runStats, affinity: save.affinity,
    });
    this.enemies.setRoster(this.run.world.enemies, this.run.unlocked);
    this.enemies.setDifficulty(this.run.difficulty, this.run.eliteChance, this.run.depth);
    this.decals.clear();
    this.telegraphs.clear();
    this.accumulatedPlaytime = save.playtime;
    this.terrainMoved = 0;
    this.brushRadius = 3;
    this.autosaveTimer = AUTOSAVE_INTERVAL;
    this.timeOfDay = 0.34;
    this.save = save;
    this.loadIterator = null;

    this.ui.applyTheme(this.affinity, this.activeElement);

    if (this.pendingIsNew || !save.tutorialDone) this.startTutorial();
    else { this.tutorialActive = false; this.ui.setTutorial('', []); }

    this.audio.unlock();
    this.audio.startAmbience();

    if (this.pendingIsNew) {
      this.ui.showReveal(save.affinity, save.worldMode);
      this.setState('reveal');
      this.playRevealSound(save.affinity);
    } else {
      this.enterPlay();
    }
  }

  private playRevealSound(affinity: AffinityId): void {
    this.audio.unlock();
    switch (affinity) {
      case 'air': this.audio.play('reveal-air'); break;
      case 'water': this.audio.play('reveal-water'); break;
      case 'earth': this.audio.play('reveal-earth'); break;
      case 'fire': this.audio.play('reveal-fire'); break;
      default: this.audio.play('reveal-convergence'); break;
    }
  }

  private finishReveal(): void {
    this.audio.play('ui-click');
    this.enterPlay();
  }

  private enterPlay(): void {
    this.setState('playing');
    this.ui.applyTheme(this.affinity, this.activeElement);
    this.input.requestLock();
    this.persist();
  }

  private pause(): void {
    if (this.state !== 'playing') return;
    this.setState('paused');
    this.input.exitLock();
    this.input.clearHeld();
    this.ui.setPauseInfo(
      this.save?.seed ?? 0, this.affinity,
      this.save?.shrines.filter(Boolean).length ?? 0, this.worldMode,
    );
    this.ui.setBuildSummary(
      this.run.build.list().map((entry) => ({
        name: entry.def.name,
        rarity: entry.def.rarity,
        stacks: entry.stacks,
        color: RARITY_COLORS[entry.def.rarity],
      })),
      this.run.build.buildPaths(),
      this.run.build.synergies(),
    );
    this.persist();
    this.audio.play('ui-back');
  }

  private resume(): void {
    if (this.state !== 'paused') return;
    this.audio.play('ui-click');
    this.setState('playing');
    this.input.requestLock();
  }

  private quitToTitle(): void {
    this.persist();
    this.audio.play('ui-back');
    this.audio.stopAmbience();
    this.input.exitLock();
    this.enemies.clear();
    this.projectiles.clear();
    this.particles.clear();
    this.refreshTitle();
    this.setState('title');
  }

  private continueAfterVictory(): void {
    this.audio.play('ui-click');
    this.setState('playing');
    this.input.requestLock();
  }

  private cancelConfirm(): void {
    this.audio.play('ui-back');
    if (this.stateBeforeConfirm === 'victory') {
      this.ui.showScreen('victory');
      this.state = 'victory';
    } else if (this.stateBeforeConfirm === 'newworld') {
      this.setState('newworld');
    } else if (this.stateBeforeConfirm === 'paused') {
      this.setState('paused');
    } else {
      this.setState('title');
    }
  }

  // ------------------------------------------------------- world mode

  private requestModeSwitch(): void {
    if (!this.save) return;
    this.audio.play('ui-click');
    const target: WorldMode = this.worldMode === 'peaceful' ? 'normal' : 'peaceful';
    this.stateBeforeConfirm = 'paused';
    if (target === 'normal') {
      this.ui.askConfirm(
        'Return to Normal Mode?',
        'Hostile creatures will return to the Verdance, and every shrine you have not yet cleansed will have its guardian restored. They will appear away from you, not on top of you.',
        () => this.setWorldMode('normal'),
        'Bring them back',
      );
    } else {
      this.ui.askConfirm(
        'Switch to Peaceful Mode?',
        'Every hostile creature vanishes and none will spawn. Shrines are cleansed by gathering three elemental motes instead. Falling and drowning can still hurt you.',
        () => this.setWorldMode('peaceful'),
        'Make it peaceful',
      );
    }
    this.setState('confirm');
  }

  private setWorldMode(mode: WorldMode): void {
    if (!this.save) return;
    this.worldMode = mode;
    this.save.worldMode = mode;
    this.enemies.setMode(mode);
    this.shrines.setMode(mode);
    if (mode === 'normal') {
      // Guardians come back only for shrines that are still blighted.
      this.shrines.resetGuardianSpawns();
      this.ui.toast('Normal Mode - the corrupted return', 'warn', 3.4);
    } else {
      this.ui.toast('Peaceful Mode - the Verdance falls quiet', 'good', 3.4);
    }
    this.persist();
    this.setState('paused');
    this.ui.setPauseInfo(this.save.seed, this.affinity, this.save.shrines.filter(Boolean).length, mode);
  }

  // ------------------------------------------------------------ tutorial

  private startTutorial(): void {
    this.tracker = createTracker();
    this.tutorialSteps = buildTutorial(this.affinity, this.activeElement, this.worldMode);
    this.tutorialActive = true;
    this.ui.setTutorial(
      tutorialTitle(this.affinity),
      this.tutorialSteps.map((s) => ({ text: s.text, done: false })),
    );
  }

  private replayTutorial(): void {
    this.audio.play('ui-click');
    this.startTutorial();
    if (this.save) this.save.tutorialDone = false;
    this.resume();
  }

  private updateTutorial(): void {
    if (!this.tutorialActive) return;
    const flags = this.tutorialSteps.map((s) => s.isDone(this.tracker));
    this.ui.updateTutorialProgress(flags);
    if (flags.every(Boolean)) {
      this.tutorialActive = false;
      this.ui.dismissTutorial();
      this.ui.toast('Training complete - the Verdance is yours to mend', 'good', 3.4);
    }
  }

  // --------------------------------------------------------------- input

  private handleGlobalKey(code: string): void {
    if (code === 'Escape') {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
      else if (this.state === 'satchel') this.closeSatchel();
      else if (this.state === 'settings') this.closeSettings();
      else if (this.state === 'confirm' || this.state === 'newworld') this.cancelConfirm();
      return;
    }
    if (code === 'F3') {
      this.fpsVisible = !this.fpsVisible;
      this.ui.setFps(this.fpsVisible ? '' : null);
    }
    if (code === 'F9') {
      // Development builds only; a no-op in a production bundle.
      const on = this.combatDebug.toggle();
      this.ui.setCombatDebug(on ? '' : null);
      if (on) this.ui.toast('Combat debug on', 'plain', 1.4);
    }
    if (code === 'KeyI') {
      if (this.state === 'playing') this.openSatchel();
      else if (this.state === 'satchel') this.closeSatchel();
    }
  }

  private openSatchel(): void {
    this.audio.play('ui-click');
    this.state = 'satchel';
    this.input.exitLock();
    this.input.clearHeld();
    this.refreshSatchel();
  }

  private refreshSatchel(): void {
    this.ui.showSatchel(
      this.inventory.slots
        .map((id) => ({ id, amount: this.inventory.countMaterial(id) }))
        .filter((m) => m.amount > 0),
      CONSUMABLE_ORDER.map((id) => ({ id, count: this.inventory.countItem(id) })),
      (id) => this.canUseItem(id),
    );
  }

  private closeSatchel(): void {
    if (this.state !== 'satchel') return;
    this.audio.play('ui-back');
    this.setState('playing');
    this.input.requestLock();
  }

  // ---------------------------------------------------------- main loop

  private frame(now: number): void {
    if (!this.running) return;
    requestAnimationFrame((t) => this.frame(t));

    const rawDt = (now - this.lastTime) / 1000;
    this.lastTime = now;
    let dt = Math.min(0.05, Math.max(0, rawDt));

    // Hit-stop: briefly slow time so heavy impacts land with weight.
    if (this.hitStopTimer > 0) {
      this.hitStopTimer -= dt;
      dt *= 0.12;
    }

    if (this.viewportW !== window.innerWidth || this.viewportH !== window.innerHeight) {
      this.onResize();
    }

    this.ui.tickOverlays(dt);

    if (this.state === 'loading' && this.loadIterator) {
      this.stepLoading();
    } else if (this.state === 'playing') {
      this.updatePlaying(dt);
    } else if (this.state === 'paused' || this.state === 'dead' || this.state === 'upgrade'
               || this.state === 'victory' || this.state === 'satchel' || this.state === 'reward') {
      // Keep the world alive behind the menus.
      this.particles.update(dt);
      this.flora.update(dt);
      this.props.update(dt, this.renderer.camera.position, this.renderer.renderDistanceUnits);
      this.world.update(dt, this.renderer.camera, this.renderer.renderDistanceUnits);
    }

    const hasWorld = !!this.world.density;
    if (hasWorld && this.state !== 'title' && this.state !== 'settings'
        && this.state !== 'confirm' && this.state !== 'newworld') {
      this.renderer.followCamera();
      const tintStrength = this.shrines.environmentTint(this.player.position, _tintColor);
      this.renderer.updateDayNight(this.timeOfDay, _tintColor, tintStrength);
      this.water.update(
        dt, this.renderer.sunDir, this.renderer.sunColor,
        this.renderer.fogColor, this.renderer.fogNear, this.renderer.fogFar,
      );
    } else {
      this.renderer.updateDayNight(this.timeOfDay, _tintColor, 0);
    }
    this.renderer.render();

    this.frameCount++;
    this.fpsTimer += dt;
    if (this.fpsTimer >= 0.5) {
      if (this.fpsVisible) {
        this.ui.setFps(
          `${Math.round(this.frameCount / this.fpsTimer)} fps · ${this.enemies.liveCount} foes · `
          + `${this.projectiles.count} shots · ${this.world.pendingChunks} chunks queued`,
        );
      }
      this.frameCount = 0;
      this.fpsTimer = 0;
    }

    this.input.endFrame();
  }

  private stepLoading(): void {
    const budgetEnd = performance.now() + 14;
    let last = { progress: 0, note: '' };
    while (performance.now() < budgetEnd && this.loadIterator) {
      const step = this.loadIterator.next();
      if (step.done) { this.loadIterator = null; break; }
      last = step.value;
    }
    if (last.note) this.ui.setLoading(last.progress, last.note);
  }

  private updatePlaying(dt: number): void {
    const input = this.input;

    if (input.locked) {
      this.player.yaw -= input.mouseDX;
      this.player.pitch -= input.mouseDY;
      const limit = Math.PI / 2 - 0.02;
      this.player.pitch = Math.max(-limit, Math.min(limit, this.player.pitch));
    }

    let moveX = 0;
    let moveZ = 0;
    if (input.isDown('KeyW')) moveZ += 1;
    if (input.isDown('KeyS')) moveZ -= 1;
    if (input.isDown('KeyD')) moveX += 1;
    if (input.isDown('KeyA')) moveX -= 1;
    const jump = input.isDown('Space');
    const shift = input.isDown('ShiftLeft') || input.isDown('ShiftRight');

    if (jump && this.player.onGround) {
      this.tracker.jumped = true;
      this.audio.play('jump', 220);
    }
    if (shift && (moveX !== 0 || moveZ !== 0)) this.tracker.sprinted = true;

    this.player.update(dt, moveX, moveZ, jump, shift);
    this.tracker.distanceMoved += this.player.position.distanceTo(this.lastPlayerPos);
    this.lastPlayerPos.copy(this.player.position);

    if (this.player.isStuck()) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.6) {
        this.player.unstick();
        this.stuckTimer = 0;
        this.ui.toast('Freed from the earth', 'warn', 1.6);
      }
    } else {
      this.stuckTimer = 0;
    }

    // ------------------------------------------------------ mode + keys
    if (input.wasPressed('Tab')) {
      this.player.mode = this.player.mode === 'element' ? 'terrain' : 'element';
      if (this.player.mode === 'terrain') this.tracker.terrainModeUsed = true;
      this.brushTimer = 0;
      this.audio.play('ui-click');
    }

    if (input.wasPressed('KeyH')) this.quickHeal();

    if (this.switchTimer > 0) this.switchTimer -= dt;
    if (isConvergence(this.affinity)) {
      for (let i = 0; i < ELEMENT_ORDER.length; i++) {
        if (!input.wasPressed(`Digit${i + 1}`)) continue;
        const next = ELEMENT_ORDER[i]!;
        if (next === this.activeElement) break;
        if (this.switchTimer > 0) {
          this.audio.play('deny', 120);
          this.ui.toast('The currents need a moment', 'warn', 1.2);
          break;
        }
        this.activeElement = next;
        this.player.activeElement = next;
        this.switchTimer = ELEMENT_SWITCH_COOLDOWN;
        this.tracker.elementSwitches++;
        this.ui.applyTheme(this.affinity, this.activeElement);
        this.ui.elementFlash(ELEMENTS[next].color, 0.3);
        this.ui.toast(`${ELEMENTS[next].name} ascendant`, 'good', 1.4);
        this.audio.play('ui-click');
        this.particles.spark({
          count: 30, x: this.player.position.x, y: this.player.position.y + 1, z: this.player.position.z,
          spread: 0.7, jitter: 4, color: ELEMENTS[next].color, color2: 0xffffff,
          size: 0.4, life: 0.7, gravity: 2,
        });
        break;
      }
    }

    this.abilities.update(dt);
    if (this.player.mode === 'element') this.handleElementMode();
    else this.handleTerrainMode(dt, shift);

    // ------------------------------------------------------------ world
    this.world.update(dt, this.renderer.camera, this.renderer.renderDistanceUnits);
    this.flora.update(dt);
    this.props.update(dt, this.player.position, this.renderer.renderDistanceUnits);
    this.projectiles.update(dt, this.world);
    this.enemies.update(dt, this.player.position, this.player.alive);
    this.enemies.harvestDeaths();
    this.shrines.update(dt, this.player.position, this.enemies, this.worldMode === 'peaceful');
    this.particles.update(dt);

    this.decals.update(dt);
    this.telegraphs.update(dt);
    this.updatePulseLights(dt);
    this.updateAtmosphere(dt);

    this.updateHealing(dt);
    this.handleInteractions(dt);

    this.player.applyToCamera(this.renderer.camera);
    if (this.player.headInWater) this.ui.elementFlash(0x1f5fbd, 0.28);

    if (this.player.nearWorldEdge()) {
      this.edgeWarned -= dt;
      if (this.edgeWarned <= 0) {
        this.edgeWarned = 6;
        this.ui.toast('The Verdance ends here - the cliffs will not let you pass', 'warn', 2.6);
      }
    }

    this.timeOfDay = (this.timeOfDay + dt / DAY_LENGTH) % 1;
    this.accumulatedPlaytime += dt;

    if (!this.player.alive && this.state === 'playing') {
      this.onDeath();
      return;
    }

    this.updateTutorial();
    this.updateHud();
    this.updateCombatDebug(dt);

    this.autosaveTimer -= dt;
    if (this.autosaveTimer <= 0) {
      this.autosaveTimer = AUTOSAVE_INTERVAL;
      this.persist();
    }
  }

  // ------------------------------------------------------- element mode

  private handleElementMode(): void {
    if (this.input.wasMousePressed(0)) this.fireAbility('primary');
    if (this.input.wasMousePressed(2)) this.fireAbility('secondary');
    this.renderer.setBrushPreview(null);
  }

  private fireAbility(slot: AbilitySlot): void {
    const result = this.abilities.use(this.activeElement, slot);
    const node = document.getElementById(slot === 'primary' ? 'ability-primary' : 'ability-secondary');
    if (result === 'ok') {
      if (slot === 'primary') this.tracker.primaryUsed = true;
      else this.tracker.secondaryUsed = true;
      node?.classList.add('fired');
      window.setTimeout(() => node?.classList.remove('fired'), 160);
    } else {
      node?.classList.remove('deny');
      void node?.offsetWidth;
      node?.classList.add('deny');
      window.setTimeout(() => node?.classList.remove('deny'), 340);
      this.audio.play('deny', 140);
      if (result === 'energy') this.ui.toast('Not enough aether', 'warn', 1.2);
      else if (result === 'cooldown') this.ui.toast('Still gathering', 'warn', 1);
      else if (result === 'blocked') this.ui.toast('No dash left in the air', 'warn', 1.2);
    }
  }

  // -------------------------------------------------------- terrain mode

  private handleTerrainMode(dt: number, fine: boolean): void {
    const eye = _v1.copy(this.player.eyePosition);
    const dir = this.player.getForward(_v2);
    const hit = this.world.raycast(eye, dir, REACH);

    // Brush sits slightly in front of the surface so the preview reads clearly.
    const point = hit
      ? hit.point.clone().addScaledVector(hit.normal, 0.25)
      : eye.clone().addScaledVector(dir, REACH * 0.75);

    const adding = this.input.isMouseDown(2);
    this.renderer.setBrushPreview(point, this.brushRadius, adding);

    // ---- brush size
    if (this.input.wasPressed('BracketLeft')) {
      this.brushRadius = clampBrush(this.brushRadius - 0.5);
      this.audio.play('ui-hover', 40);
    }
    if (this.input.wasPressed('BracketRight')) {
      this.brushRadius = clampBrush(this.brushRadius + 0.5);
      this.audio.play('ui-hover', 40);
    }

    // ---- material selection
    if (this.input.wheelDelta !== 0) {
      for (let guard = 0; guard < this.inventory.slots.length; guard++) {
        this.inventory.cycle(this.input.wheelDelta);
        if (this.inventory.canSelect(this.inventory.selectedMaterial())) break;
      }
      this.audio.play('ui-hover', 60);
    }

    const digging = this.input.isMouseDown(0);
    if (!digging && !adding) {
      this.brushTimer = 0;
      if (hit?.protectedGround) this.ui.setPrompt('Shrine foundations resist shaping', 'LMB');
      else this.ui.setPrompt(null);
      return;
    }

    this.brushTimer -= dt;
    if (this.brushTimer > 0) return;
    this.brushTimer = 1 / BRUSH_RATE;

    const material = this.inventory.selectedMaterial();
    const strengthScale = fine ? 0.4 : 1;
    const op: TerrainOp = {
      x: point.x, y: point.y, z: point.z,
      radius: this.brushRadius,
      strength: (adding ? 2.6 : -2.6) * strengthScale,
      material,
    };

    // Adding requires stock of the selected material.
    if (adding) {
      const cost = World.volumeOf(this.brushRadius, op.strength);
      if (!this.inventory.hasMaterial(material, cost * 0.35)) {
        this.audio.play('deny', 200);
        this.ui.setPrompt(`Not enough ${materialDef(material).name}`, 'RMB');
        this.inventory.selectNextAvailable();
        return;
      }
    }

    const collect = new Map<number, number>();
    const { moved, blocked } = this.world.edit(op, collect);

    if (blocked) {
      this.audio.play('deny', 200);
      this.ui.setPrompt('Shrine foundations resist shaping', adding ? 'RMB' : 'LMB');
      return;
    }
    if (moved <= 0) return;

    this.terrainMoved += moved;
    for (const [id, amount] of collect) {
      if (amount > 0) this.inventory.addMaterial(id as MaterialId, amount * 0.35);
      else if (amount < 0) this.inventory.takeMaterial(material, -amount * 0.35);
    }

    if (adding) {
      this.tracker.terrainAdded += moved;
      this.audio.play('block-place', 70);
      this.particles.debris({
        count: 5, x: point.x, y: point.y, z: point.z, spread: this.brushRadius * 0.6,
        jitter: 1.6, vy: 1.4, color: materialDef(material).color, color2: materialDef(material).deep,
        size: 0.16, life: 0.6, gravity: -8, drag: 0.9,
      });
    } else {
      this.tracker.terrainDug += moved;
      this.audio.play('mine-tick', 70);
      const dugMat = hit ? hit.material : Mat.SOIL;
      this.particles.debris({
        count: 6, x: point.x, y: point.y, z: point.z, spread: this.brushRadius * 0.5,
        jitter: 2.6, vy: 2.2, color: materialDef(dugMat).color, color2: materialDef(dugMat).deep,
        size: 0.15, life: 0.7, gravity: -10, drag: 0.8,
      });
      // Anything that was standing on the removed ground falls away.
      this.flora.pruneAround(this.world, point.x, point.z, this.brushRadius);
      this.props.pruneAround(this.world, point.x, point.z, this.brushRadius);
    }

    this.ui.setPrompt(null);
    // The player can dig the ground out from under themselves; never let that
    // leave them embedded in what remains.
    if (this.player.isStuck()) this.player.unstick();
  }

  /**
   * Blend the weather toward what this position should have.
   *
   * Nothing snaps: the storm builds, the snow thickens with altitude and the
   * mist gathers over corrupted ground over a few seconds.
   */
  private updateAtmosphere(dt: number): void {
    this.stormPhase = (this.stormPhase + dt / 240) % 1;
    const world = this.run.world;
    const height = this.player.position.y;
    let blight = 0;
    for (const shrine of this.shrines.shrines) {
      if (shrine.cleansed) continue;
      const d = Math.hypot(this.player.position.x - shrine.anchor.x, this.player.position.z - shrine.anchor.z);
      blight = Math.max(blight, Math.max(0, 1 - d / 45));
    }
    const target = weatherAt(world.weather, world.weatherIntensity, height, blight, this.stormPhase);
    this.weather.set(target.kind, target.intensity);
    this.weather.update(dt, this.renderer.camera.position);
  }

  // ------------------------------------------------------------- healing

  private updateHealing(dt: number): void {
    const ctx = this.combatContext();
    const before = this.player.health;
    const tick = tickHealing(this.healing, dt, this.player.health, this.player.maxHealth, ctx);
    if (tick.regen > 0 || tick.fromEffects > 0) {
      this.player.health = Math.min(this.player.maxHealth, this.player.health + tick.regen + tick.fromEffects);
    }
    if (tick.fromEffects > 0 && before < this.player.health) {
      if (Math.random() < dt * 3) {
        this.particles.spark({
          count: 1, x: this.player.position.x, y: this.player.position.y + 1.2, z: this.player.position.z,
          spread: 0.5, vy: 1.4, jitter: 0.6, color: 0x9bf0c4, color2: 0xffffff,
          size: 0.22, life: 0.9, gravity: 0.6, drag: 0.6,
        });
      }
    }
    for (const finished of tick.finished) {
      this.ui.toast(`${CONSUMABLES[finished].name} finished`, 'plain', 1.4);
    }

    // Rest fade-out
    if (this.restFadeTimer > 0) {
      this.restFadeTimer -= dt;
      if (this.restFadeTimer <= 0) this.ui.fade(false);
    }
  }

  private combatContext(): CombatContext {
    return {
      hostilePressure: this.enemies.hostilePressure(this.player.position, 24),
      takingDamageOverTime: this.player.takingDamageOverTime,
      element: this.activeElement,
      nearWater: this.player.nearWater(),
    };
  }

  private canUseItem(id: ConsumableId): boolean {
    const def = CONSUMABLES[id];
    if (this.inventory.countItem(id) <= 0) return false;
    if (this.player.health >= this.player.maxHealth - 0.01) return false;
    const cd = def.kind === 'potion' ? this.healing.potionCooldown : this.healing.foodCooldown;
    return cd <= 0;
  }

  /** `H` - use the most appropriate healing item for the damage taken. */
  private quickHeal(): void {
    const choice = chooseHealingItem(
      this.inventory, this.player.health, this.player.maxHealth, this.healing.potionCooldown <= 0,
    );
    if (!choice) {
      this.audio.play('deny', 200);
      this.ui.toast(
        this.player.health >= this.player.maxHealth - 0.01 ? 'Already at full health' : 'Nothing suitable to use',
        'warn', 1.6,
      );
      return;
    }
    this.useItem(choice, false);
  }

  private useItem(id: ConsumableId, fromSatchel: boolean): void {
    const result = consume(
      this.healing, id, this.player.health, this.player.maxHealth, this.combatContext(),
      (item) => this.inventory.takeItem(item),
    );
    if (!result.ok) {
      this.audio.play('deny', 200);
      const message = result.reason === 'full' ? 'Already at full health'
        : result.reason === 'cooldown' ? 'Still recovering from the last one'
          : result.reason === 'duplicate' ? 'That is already working'
            : 'None left';
      this.ui.toast(message, 'warn', 1.6);
      return;
    }

    const def = CONSUMABLES[id];
    this.tracker.healingUsed = true;
    this.audio.play(def.kind === 'potion' ? 'heal' : 'pickup', 40);
    this.ui.healFlash(def.kind === 'potion' ? 'potion' : 'food');
    this.ui.toast(`${def.name} used`, 'good', 1.8);
    this.player.addShake(0.05, 10);
    this.particles.spark({
      count: 26, x: this.player.position.x, y: this.player.position.y + 1.1, z: this.player.position.z,
      spread: 0.6, vy: 2.2, jitter: 1.4, color: def.color, color2: 0xffffff,
      size: 0.3, life: 1.1, gravity: 0.8, drag: 0.8,
    });
    if (fromSatchel) this.refreshSatchel();
  }

  // -------------------------------------------------------- interactions

  /** Shrines, motes, resting and looting all share the `E` key. */
  private handleInteractions(dt: number): void {
    const holdingE = this.input.isDown('KeyE');
    const pressedE = this.input.wasPressed('KeyE');
    const pos = this.player.position;

    // ---- 1. ritual motes (Peaceful Mode)
    const mote = this.shrines.nearestMote(pos);
    if (mote) {
      this.ui.setPrompt('Gather the elemental mote', 'E');
      if (pressedE) {
        this.shrines.gatherMote(mote.shrine, mote.mote);
        this.audio.play('pickup');
        this.ui.elementFlash(ELEMENTS[SHRINE_SITES[mote.shrine]!.element].color, 0.3);
        if (this.save) {
          this.save.motes[mote.shrine] = this.shrines.motesGathered(mote.shrine);
          this.persist();
        }
        const left = MOTES_PER_SHRINE - this.shrines.motesGathered(mote.shrine).filter(Boolean).length;
        this.ui.toast(left > 0 ? `Mote gathered - ${left} to go` : 'All motes gathered - return to the shrine', 'good', 3);
      }
      return;
    }

    // ---- 2. shrine interaction
    const interaction = this.shrines.getInteraction(pos, this.enemies);
    if (interaction && interaction.status !== 'done') {
      const site = SHRINE_SITES[interaction.index]!;
      const name = ELEMENTS[site.element].shrineName;
      if (interaction.status === 'guardian') {
        this.ui.setPrompt(`${name} · the guardian still stands`, '!');
        this.cleanseProgress = 0;
        return;
      }
      if (interaction.status === 'ritual') {
        this.ui.setPrompt(`${name} · gather ${interaction.motesLeft} more elemental mote${interaction.motesLeft === 1 ? '' : 's'}`, '!');
        this.cleanseProgress = 0;
        return;
      }
      // status === 'cleanse'
      if (holdingE) {
        if (this.cleanseTarget !== interaction.index) {
          this.cleanseTarget = interaction.index;
          this.cleanseProgress = 0;
        }
        this.cleanseProgress += dt;
        const frac = Math.min(1, this.cleanseProgress / CLEANSE_DURATION);
        this.ui.setPrompt(`Cleansing ${name}…`, 'E', frac);
        const anchor = this.shrines.shrines[interaction.index]!.anchor;
        this.particles.spark({
          count: 3, x: anchor.x, y: anchor.y + 1, z: anchor.z, spread: 3,
          vy: 5, jitter: 1.4, color: ELEMENTS[site.element].color, color2: 0xffffff,
          size: 0.36, life: 0.7, gravity: 1.5,
        });
        if (this.cleanseProgress >= CLEANSE_DURATION) this.cleanseShrine(interaction.index);
      } else {
        this.cleanseProgress = 0;
        this.ui.setPrompt(`Hold to cleanse ${name}`, 'E');
      }
      return;
    }
    this.cleanseProgress = 0;
    this.cleanseTarget = -1;

    // ---- 3. looting props
    const prop = this.props.nearest(pos);
    if (prop && prop.kind !== 'campfire') {
      const label = prop.kind === 'bush' ? 'Forage the sunberry bush' : 'Open the supply cache';
      this.ui.setPrompt(label, 'E');
      if (pressedE) this.lootProp(prop);
      return;
    }

    // ---- 4. resting at a campfire or cleansed shrine
    const restProp = this.props.restSiteNear(pos);
    const restShrine = this.shrines.restSiteNear(pos);
    const atRestSite = !!restProp || !!restShrine;
    const restCtx = {
      atRestSite,
      hostileNearby: this.enemies.hostilePressure(pos, 22),
      peaceful: this.worldMode === 'peaceful',
    };
    if (atRestSite) {
      const check = canRest(restCtx);
      if (!check.ok) {
        this.ui.setPrompt('Too dangerous to rest here', '!');
      } else {
        const done = tickRest(this.healing, dt, holdingE, restCtx);
        const frac = Math.min(1, this.healing.restProgress / REST_DURATION);
        this.ui.setPrompt(
          this.healing.resting ? 'Resting…' : 'Hold to rest', 'E', this.healing.resting ? frac : 0,
        );
        if (this.healing.resting && this.restFadeTimer <= 0) this.ui.fade(true);
        if (!this.healing.resting && this.restFadeTimer <= 0) this.ui.fade(false);
        if (done) this.completeRest(restShrine ? 'shrine' : 'campfire');
      }
      return;
    }
    if (this.healing.resting) {
      this.healing.resting = false;
      this.healing.restProgress = 0;
      this.ui.fade(false);
    }

    if (this.player.mode === 'element') this.ui.setPrompt(null);
  }

  private lootProp(prop: ReturnType<Props['nearest']>): void {
    if (!prop) return;
    const loot = this.props.loot(prop);
    if (!loot) return;
    this.inventory.addItem(loot.item, loot.count);
    this.audio.play('pickup');
    this.ui.toast(`Found ${loot.count} × ${CONSUMABLES[loot.item].name}`, 'good', 2.4);
    this.particles.spark({
      count: 22, x: prop.position.x, y: prop.position.y + 0.9, z: prop.position.z,
      spread: 0.5, vy: 2, jitter: 1.8, color: CONSUMABLES[loot.item].color, color2: 0xffffff,
      size: 0.3, life: 0.9, gravity: 0.8, drag: 0.8,
    });
    if (this.save) {
      this.save.lootedProps = this.props.lootedIds();
      this.persist();
    }
  }

  private completeRest(kind: 'campfire' | 'shrine'): void {
    this.player.health = this.player.maxHealth;
    this.player.energy = this.player.maxEnergy;
    this.player.breath = BREATH_SECONDS;
    clearEffects(this.healing);
    this.healing.sinceDamaged = 999;
    this.healing.sinceDealt = 999;
    this.healing.potionCooldown = 0;
    this.healing.foodCooldown = 0;
    this.abilities.reset();

    // A rest costs a slice of the day.
    this.timeOfDay = (this.timeOfDay + 0.06) % 1;

    if (this.save) {
      this.save.respawn = [this.player.position.x, this.player.position.y, this.player.position.z];
      this.persist();
    }

    this.audio.play('upgrade');
    this.ui.healFlash('rest');
    this.ui.toast(
      kind === 'shrine' ? 'Rested at the cleansed shrine - fully restored' : 'Rested at the campfire - fully restored',
      'good', 3,
    );
    this.ui.fade(false);
    this.restFadeTimer = 0.6;
  }

  // ------------------------------------------------------------- shrines

  private cleanseShrine(index: number): void {
    if (!this.save || this.save.shrines[index]) return;
    this.cleanseProgress = 0;
    this.cleanseTarget = -1;

    this.shrines.cleanse(index);
    this.save.shrines[index] = true;
    this.save.guardians[index] = true;
    this.save.motes[index] = [true, true, true];
    this.enemies.setCleansed(this.save.shrines);
    this.tracker.shrineCleansed = true;

    this.audio.play('shrine-cleanse');
    this.player.addShake(0.5, 3);
    this.ui.elementFlash(ELEMENTS[SHRINE_SITES[index]!.element].color, 0.5);

    this.save.respawn = this.safeSpotNear(this.shrines.shrines[index]!.anchor);

    this.run.completeEncounter();
    const upgradeIndex = Math.min(SHRINE_UPGRADES.length - 1, this.save.upgrades);
    this.save.upgrades = Math.min(SHRINE_UPGRADES.length, this.save.upgrades + 1);
    const stats = accumulateUpgrades(this.save.upgrades, isConvergence(this.affinity));
    this.player.applyStats(stats, true);
    if (upgradeIndex === 0) this.player.health = this.player.maxHealth;
    this.player.energy = this.player.maxEnergy;

    this.persist();

    const upgrade = SHRINE_UPGRADES[upgradeIndex]!;
    const pres = affinityPresentation(this.affinity);
    const lines = [...upgrade.lines];
    if (isConvergence(this.affinity)) lines.push('Convergence: the bonus is spread across all four currents');
    else lines.push(`${ELEMENTS[this.affinity as ElementId].name} grows stronger`);

    window.setTimeout(() => {
      this.audio.play('upgrade');
      this.input.exitLock();
      this.ui.showUpgrade(upgrade.title, lines, pres.symbol, pres.color);
      this.setState('upgrade');
    }, 900);
  }

  /** Open standing room near a point, so respawns never land inside terrain. */
  private safeSpotNear(anchor: THREE.Vector3): [number, number, number] {
    for (let radius = 8; radius <= 16; radius += 4) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const x = anchor.x + Math.cos(a) * radius;
        const z = anchor.z + Math.sin(a) * radius;
        const ground = this.world.groundHeight(x, z);
        if (ground < SEA_LEVEL) continue;
        if (this.world.isSolid(x, ground + 1.2, z)) continue;
        return [x, ground + 0.3, z];
      }
    }
    return [anchor.x, anchor.y + 1, anchor.z];
  }

  private finishUpgrade(): void {
    this.audio.play('ui-click');
    if (this.save && allShrinesCleansed(this.save.shrines)) {
      this.audio.play('victory');
      this.ui.showVictory(
        this.affinity, this.save.seed, this.worldMode,
        this.accumulatedPlaytime, this.terrainMoved, this.enemies.kills,
      );
      this.setState('victory');
      this.persist();
      return;
    }
    this.setState('playing');
    this.input.requestLock();
  }

  private onGuardianDefeated(index: number): void {
    this.shrines.markGuardianDefeated(index);
    if (this.save) {
      this.save.guardians[index] = true;
      this.persist();
    }
    const site = SHRINE_SITES[index]!;
    this.ui.toast(`The guardian of the ${ELEMENTS[site.element].shrineName} falls`, 'good', 3.4);
  }

  // ------------------------------------------------------------- combat

  private damagePlayer(amount: number, from: THREE.Vector3, knockback: number): void {
    if (this.state !== 'playing') return;
    const dealt = this.player.applyDamage(amount, from, knockback);
    if (dealt <= 0) return;
    notifyDamaged(this.healing);
    this.audio.play('hurt', 120);
    this.ui.damageFlash(0.3 + Math.min(0.5, dealt / 60));
    this.showDamageDirection(from.x, from.z);
  }

  /**
   * Continuous projectile collision.
   *
   * The whole segment the projectile covered this frame is swept against the
   * body capsules, so a fast Fireball cannot step over a creature between two
   * frames. Returns the contact point, or null for a clean pass.
   */
  private onProjectileSweep(
    p: Projectile, from: THREE.Vector3, to: THREE.Vector3,
  ): THREE.Vector3 | null {
    _sweepA.x = from.x; _sweepA.y = from.y; _sweepA.z = from.z;
    _sweepB.x = to.x; _sweepB.y = to.y; _sweepB.z = to.z;

    if (p.owner === 'player') {
      // Earliest contact along the path wins, so a shot cannot skip the near
      // target and hit the far one.
      let enemy: Enemy | null = null;
      let bestT = Infinity;
      for (const e of this.enemies.live) {
        if (!e.alive) continue;
        const sweep = sweptSphereVsCapsule(_sweepA, _sweepB, p.radius, e.hitCapsule());
        if (!sweep.hit || sweep.t >= bestT) continue;
        bestT = sweep.t;
        enemy = e;
        _contact.set(sweep.point.x, sweep.point.y, sweep.point.z);
      }
      if (!enemy) return null;
      const point = _contact;
      const kb = _v2.copy(p.vel).normalize().multiplyScalar(p.knockback ?? 0);
      const element = this.elementOfProjectile(p);
      if (element) {
        // Go through the ability funnel so crits, elemental reactions,
        // lifesteal and upgrade behaviours all apply to projectiles too.
        this.abilities.hitEnemy(
          enemy, p.damage, element, p.knockback ? kb : null, p.stagger ?? 0,
          p.burn ? { id: 'burning', seconds: 4, magnitude: p.burn } : undefined,
        );
      } else {
        enemy.damage(p.damage, null, p.knockback ? kb : null, p.stagger ?? 0);
        this.ui.hitMarker(false);
      }
      if (p.slow) enemy.applySlow(0.55, p.slow);
      notifyDealtDamage(this.healing);

      // `rock-fragment`: burst into shards on a direct hit.
      const fragments = p.fragments ?? 0;
      if (fragments > 0 && p.kind === 'rock') this.spawnFragments(p, point, fragments);
      return point;
    }

    // Hostile shots sweep against the player's own body capsule.
    const body = bodyCapsule(
      this.player.position.x, this.player.position.y, this.player.position.z,
      1.8, 0.42, 0.1,
    );
    const sweep = sweptSphereVsCapsule(_sweepA, _sweepB, p.radius, body);
    if (!sweep.hit) return null;
    _contact.set(sweep.point.x, sweep.point.y, sweep.point.z);
    this.damagePlayer(p.damage, _v1.copy(_contact), 3.5);
    return _contact;
  }

  private elementOfProjectile(p: Projectile): ElementId | null {
    switch (p.kind) {
      case 'rock': return 'earth';
      case 'fireball': return 'fire';
      case 'bolt': return p.deflected ? 'air' : null;
      case 'orb': return p.deflected ? 'air' : null;
      default: return null;
    }
  }

  private onProjectileImpact(p: Projectile, point: THREE.Vector3, hitEntity: boolean): void {
    const blast = p.blast ?? 0;
    if (p.kind === 'fireball') {
      this.audio.play('impact', 40);
      this.particles.spark({
        count: 64, x: point.x, y: point.y, z: point.z, spread: 0.5, jitter: 8,
        color: 0xffb04d, color2: 0xffe08a, size: 0.48, life: 0.6, gravity: 3, drag: 1.6,
      });
      this.particles.debris({
        count: 14, x: point.x, y: point.y, z: point.z, spread: 0.4, jitter: 5,
        color: 0xd43f1a, size: 0.18, life: 0.7, gravity: -10, drag: 0.7,
      });
      this.ui.elementFlash(ELEMENTS.fire.color, 0.22);
      this.world.normalAt(point.x, point.y, point.z, _v1);
      this.decals.add('scorch', point.x, point.y, point.z, _v1, 2.6, 12, 0.8);
      this.addPulseLight(point.x, point.y, point.z, 0xff8a2a, 14, 0.35);
    } else if (p.kind === 'rock') {
      this.audio.play('impact', 40);
      // A heavy boulder actually dents the ground it lands on.
      if (!hitEntity && !this.world.isProtected(point.x, point.y, point.z)) {
        this.world.addTemporary({
          x: point.x, y: point.y, z: point.z,
          radius: 1.5, strength: -1.6, material: Mat.SOIL,
        }, 26);
      }
      this.world.normalAt(point.x, point.y, point.z, _v1);
      this.decals.add('crack', point.x, point.y, point.z, _v1, 2.4, 14, 0.8);
      this.particles.debris({
        count: 28, x: point.x, y: point.y, z: point.z, spread: 0.45, jitter: 6,
        color: 0x8a6440, color2: 0x503a24, size: 0.24, life: 1, gravity: -14, drag: 0.55,
      });
      this.particles.spark({
        count: 16, x: point.x, y: point.y, z: point.z, spread: 0.5, jitter: 3,
        color: 0xd9c08a, size: 0.28, life: 0.5, gravity: -3,
      });
      this.player.addShake(0.12, 8);
    } else {
      this.particles.spark({
        count: 18, x: point.x, y: point.y, z: point.z, spread: 0.3, jitter: 4.5,
        color: p.color ?? 0xc07bff, color2: 0xffffff, size: 0.28, life: 0.4, gravity: 1,
      });
    }

    if (blast > 0) {
      const shockCentre = _v1.set(point.x, point.y, point.z);
      const element = this.elementOfProjectile(p);
      for (const e of this.enemies.within(shockCentre, blast, _enemyScratch)) {
        const kb = _v2.copy(e.center).sub(shockCentre).normalize().multiplyScalar((p.knockback ?? 0) * 0.8);
        const amount = p.damage * (hitEntity ? 0.45 : 0.85);
        if (element) {
          this.abilities.hitEnemy(
            e, amount, element, kb, (p.stagger ?? 0) * 0.6,
            p.burn ? { id: 'burning', seconds: 4, magnitude: p.burn } : undefined,
          );
        } else {
          e.damage(amount, null, kb, (p.stagger ?? 0) * 0.6);
        }
        notifyDealtDamage(this.healing);
      }
      if (p.owner === 'player' && shockCentre.distanceTo(this.player.position) < blast * 0.8) {
        this.player.addShake(0.35, 6);
      }
    }
  }

  /** `rock-fragment`: a boulder bursts into smaller shards on impact. */
  private spawnFragments(p: Projectile, point: THREE.Vector3, count: number): void {
    const shards = 2 + count;
    for (let i = 0; i < shards; i++) {
      const a = (i / shards) * Math.PI * 2;
      _v1.set(Math.cos(a), 0.45, Math.sin(a)).normalize();
      this.projectiles.spawn({
        kind: 'rock', owner: 'player',
        origin: point.clone().addScaledVector(_v1, 0.4),
        direction: _v1.clone(),
        speed: 18, damage: p.damage * 0.3, radius: 0.3,
        blast: 0.8, life: 1.2, gravity: 14, knockback: 3,
        color: 0x8b7d68, element: 'earth',
      });
    }
  }

  private onProjectileTrail(p: Projectile): void {
    if (p.kind === 'fireball') {
      this.particles.spark({
        count: 2, x: p.pos.x, y: p.pos.y, z: p.pos.z, spread: 0.12, jitter: 0.8,
        color: 0xffb04d, color2: 0xd43f1a, size: 0.3, life: 0.3, gravity: 1.6, drag: 2,
      });
    } else if (p.kind === 'rock') {
      this.particles.debris({
        count: 1, x: p.pos.x, y: p.pos.y, z: p.pos.z, spread: 0.1, jitter: 0.6,
        color: 0x8a6440, size: 0.12, life: 0.35, gravity: -4, drag: 1.4,
      });
    } else {
      this.particles.spark({
        count: 1, x: p.pos.x, y: p.pos.y, z: p.pos.z, spread: 0.1, jitter: 0.5,
        color: p.color ?? 0xc07bff, size: 0.22, life: 0.24, gravity: 0, drag: 1.6,
      });
    }
  }

  // ------------------------------------------------------- death & save

  private onDeath(): void {
    this.setState('dead');
    this.input.exitLock();
    this.audio.play('hurt');
    this.ui.damageFlash(0.95);
    clearEffects(this.healing);
    const lost = Math.round(this.player.maxEnergy * 0.4);
    this.ui.showDeath(
      `The Verdance takes its due. You lose ${lost} aether, but your world, your affinity, your blessings, your terrain and every cleansed shrine remain.`,
    );
    if (this.save) this.persist();
  }

  private respawn(): void {
    this.audio.play('ui-click');
    const point = this.save?.respawn ?? [this.world.spawn.x, this.world.spawn.y, this.world.spawn.z];
    let [x, y, z] = point;
    if (!inWorld(x, y, z)) {
      x = this.world.spawn.x; y = this.world.spawn.y; z = this.world.spawn.z;
    }
    this.player.teleport(x, y + 0.2, z);
    this.player.unstick();
    this.player.alive = true;
    this.player.health = this.player.maxHealth;
    this.player.energy = Math.max(0, this.player.maxEnergy * 0.6);
    this.player.invulnTimer = 2;
    this.player.breath = BREATH_SECONDS;
    this.healing = createHealingState();
    this.abilities.reset();
    this.projectiles.clear();

    for (const e of this.enemies.enemies) {
      if (e.shrineIndex >= 0) continue;
      if (e.pos.distanceTo(this.player.position) < 26) this.enemies.kill(e);
    }

    this.setState('playing');
    this.input.requestLock();
    this.persist();
  }

  private persist(): void {
    if (!this.save) return;
    this.save.position = [this.player.position.x, this.player.position.y, this.player.position.z];
    this.save.yaw = this.player.yaw;
    this.save.pitch = this.player.pitch;
    this.save.health = this.player.health;
    this.save.energy = this.player.energy;
    this.save.activeElement = this.activeElement;
    this.save.worldMode = this.worldMode;
    this.save.materials = this.inventory.materialsToJSON();
    this.save.items = this.inventory.consumablesToJSON();
    this.save.terrainOps = serialiseOps(this.world.journal.ops);
    this.save.lootedProps = this.props.lootedIds();
    for (let i = 0; i < SHRINE_SITES.length; i++) this.save.motes[i] = this.shrines.motesGathered(i);
    this.save.playtime = this.accumulatedPlaytime;
    this.save.tutorialDone = !this.tutorialActive;
    const run = this.run.toJSON();
    this.save.build = run.build;
    this.save.meta = run.meta;
    this.save.depth = run.depth;
    this.save.encounters = run.encounters;
    this.save.worldTheme = run.worldTheme;
    this.save.runStats = run.runStats;
    if (!writeSave(window.localStorage, this.save)) {
      this.ui.toast('Could not write the save - browser storage refused', 'bad', 4);
    }
  }

  // ----------------------------------------------------------------- HUD

  /**
   * Pre-fire crosshair feedback.
   *
   * Resolved with the same aiming code the abilities use, so "the crosshair
   * says I am on target" and "the shot will connect" cannot disagree.
   */
  private updateCrosshair(primaryCd: number): void {
    if (this.state !== 'playing' || !this.player.alive) {
      this.ui.setCrosshairState('neutral');
      this.debugFrame = null;
      return;
    }
    if (this.player.mode !== 'element') {
      this.ui.setCrosshairState('neutral');
      return;
    }

    const def = ELEMENTS[this.activeElement].primary;
    const cfg = abilityCombat(def.id);
    const aim = this.abilities.probeAim(cfg.range);

    let crosshair: CrosshairState;
    if (this.switchTimer > 0) crosshair = 'invalid';
    else if (primaryCd > 0) crosshair = 'cooldown';
    else if (!this.abilities.affordable(this.activeElement, 'primary')) crosshair = 'no-energy';
    else if (aim.targetId !== null) crosshair = 'target';
    else if (aim.blockedByTerrain && aim.distance < 2.5) crosshair = 'blocked';
    else crosshair = 'neutral';
    this.ui.setCrosshairState(crosshair);

    if (!this.combatDebug.enabled) {
      this.debugFrame = null;
      return;
    }
    this.abilities.debugHitboxes(this.debugBoxes);
    this.debugVolumes.length = 0;
    this.debugPaths.length = 0;
    for (const shot of this.projectiles.liveShots) {
      this.debugPaths.push({
        from: { x: shot.pos.x, y: shot.pos.y, z: shot.pos.z },
        to: {
          x: shot.pos.x + shot.vel.x * 0.1,
          y: shot.pos.y + shot.vel.y * 0.1,
          z: shot.pos.z + shot.vel.z * 0.1,
        },
      });
    }
    const eye = this.player.eyePosition;
    const forward = this.player.getForward(_v2);
    this.debugFrame = {
      eye: { x: eye.x, y: eye.y, z: eye.z },
      forward: { x: forward.x, y: forward.y, z: forward.z },
      target: aim.target,
      blockedByTerrain: aim.blockedByTerrain,
      range: cfg.range,
      targetId: aim.targetId,
      hitboxes: this.debugBoxes,
      volumes: this.debugVolumes,
      paths: this.debugPaths,
      tokens: this.enemies.tokens,
      cooldown: primaryCd,
      energy: this.player.energy,
    };
  }

  /** Redraw the debug overlay. Cheap no-op while it is disabled. */
  private updateCombatDebug(dt: number): void {
    if (!this.combatDebug.enabled || !this.debugFrame) return;
    this.combatDebug.update(dt, this.debugFrame);
    this.ui.setCombatDebug(this.combatDebug.readout(this.debugFrame));
  }

  private updateHud(): void {
    const primaryCd = this.abilities.fraction(this.activeElement, 'primary');
    const secondaryCd = this.abilities.fraction(this.activeElement, 'secondary');
    const effect = this.healing.effects[0] ?? null;
    const state: HudState = {
      health: this.player.health,
      maxHealth: this.player.maxHealth,
      energy: this.player.energy,
      maxEnergy: this.player.maxEnergy,
      affinity: this.affinity,
      activeElement: this.activeElement,
      mode: this.player.mode,
      worldMode: this.worldMode,
      primaryCd,
      secondaryCd,
      primaryReady: primaryCd === 0 && this.abilities.affordable(this.activeElement, 'primary'),
      secondaryReady: secondaryCd === 0 && this.abilities.affordable(this.activeElement, 'secondary'),
      shrinesCleansed: this.save?.shrines.filter(Boolean).length ?? 0,
      yaw: this.player.yaw,
      playerX: this.player.position.x,
      playerZ: this.player.position.z,
      shrineFlags: this.save?.shrines ?? [false, false, false, false],
      passive: this.currentPassiveLabel(),
      materials: this.inventory.slots.map((id) => ({
        id,
        amount: this.inventory.countMaterial(id),
        locked: !this.inventory.canSelect(id),
      })),
      materialSelected: this.inventory.selected,
      brushRadius: this.brushRadius,
      brushFine: this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight'),
      switchLocked: this.switchTimer > 0,
      regenActive: this.healing.regenActive,
      effect: effect ? { id: effect.id, fraction: effect.timeLeft / effect.duration } : null,
      potionCooldown: this.healing.potionCooldown,
      potionCooldownMax: CONSUMABLES.minorPotion.cooldown,
      items: CONSUMABLE_ORDER.map((id) => ({ id, count: this.inventory.countItem(id) })),
      breath: this.player.breath,
      maxBreath: BREATH_SECONDS,
    };
    this.ui.updateHud(state);
    this.ui.setLowHealth(this.player.health / this.player.maxHealth);
    this.updateCrosshair(primaryCd);

    // Status chips: what is currently affecting the player.
    _statusScratch.length = 0;
    if (this.player.takingDamageOverTime) {
      _statusScratch.push({ id: 'corrupted' as const, stacks: 1 });
    }
    if (this.player.shield > 0) _statusScratch.push({ id: 'armored' as const, stacks: 1 });
    if (this.player.tempArmor > 0) _statusScratch.push({ id: 'armored' as const, stacks: 1 });
    if (this.player.inWater) _statusScratch.push({ id: 'wet' as const, stacks: 1 });
    // De-duplicate while keeping the first occurrence.
    const seen = new Set<string>();
    const chips = _statusScratch.filter((c) => {
      if (seen.has(c.id)) return false;
      seen.add(c.id);
      return STATUSES[c.id] !== undefined;
    });
    this.ui.setStatuses(chips);
  }

  private currentPassiveLabel(): string | null {
    switch (this.activeElement) {
      case 'fire':
        return this.player.firePassiveActive()
          ? `Last Ember · fire +${Math.round((this.player.firePassiveMultiplier() - 1) * 100)}%`
          : null;
      case 'water':
        return this.player.nearWater() ? 'Tidemend · recovery quickened' : null;
      case 'earth':
        return this.player.standingOnFirmGround() ? 'Rootbound · braced' : null;
      default:
        return !this.player.onGround ? 'Featherstep · aloft' : null;
    }
  }

  // --------------------------------------------------------------- misc

  /** Short-lived point light for an elemental impact. */
  private addPulseLight(x: number, y: number, z: number, color: number, intensity: number, seconds: number): void {
    if (!this.settings.postProcessing && this.pulseLights.length >= 2) return;
    if (this.pulseLights.length >= this.maxPulseLights) {
      // Recycle the dimmest one rather than growing the light count.
      let worst = 0;
      for (let i = 1; i < this.pulseLights.length; i++) {
        if (this.pulseLights[i]!.life < this.pulseLights[worst]!.life) worst = i;
      }
      const entry = this.pulseLights[worst]!;
      entry.light.position.set(x, y, z);
      entry.light.color.setHex(color);
      entry.light.intensity = intensity;
      entry.life = seconds;
      return;
    }
    const light = new THREE.PointLight(color, intensity, 22, 2);
    light.position.set(x, y, z);
    this.renderer.scene.add(light);
    this.pulseLights.push({ light, life: seconds });
  }

  private updatePulseLights(dt: number): void {
    for (let i = this.pulseLights.length - 1; i >= 0; i--) {
      const entry = this.pulseLights[i]!;
      entry.life -= dt;
      if (entry.life <= 0) {
        this.renderer.scene.remove(entry.light);
        entry.light.dispose();
        this.pulseLights.splice(i, 1);
      } else {
        entry.light.intensity *= 0.88;
      }
    }
  }

  /** Directional damage indicator, also used for off-screen attack warnings. */
  private showDamageDirection(fromX: number, fromZ: number, warningOnly = false): void {
    const bearing = relativeBearing(
      fromX, fromZ, this.player.position.x, this.player.position.z, this.player.yaw,
    );
    this.ui.showDamageArrow(bearing, warningOnly);
  }

  /** A creature died: count it, and offer a reward when an encounter closes. */
  private onEnemyKilled(kind: EnemyKind, elites: readonly EliteId[]): void {
    const boss = ENEMY_TYPES[kind].role === 'boss';
    this.run.recordKill(elites.length > 0, boss);
    if (this.save) {
      this.save.runStats.enemiesFelled = this.run.stats.enemiesFelled;
      this.save.runStats.elitesFelled = this.run.stats.elitesFelled;
      this.save.runStats.bossesFelled = this.run.stats.bossesFelled;
    }
    // An elite or a boss always closes an encounter and pays out.
    if (elites.length > 0 || boss) {
      this.offerRewards(boss ? 2.2 : 1.4);
    }
  }

  /** Pause safely and present three upgrade choices. */
  private offerRewards(luck: number): void {
    if (this.state !== 'playing') return;
    const offers = this.run.offerRewards(Math.random, luck);
    if (offers.length === 0) return;
    this.run.completeEncounter();
    this.persist();
    this.input.exitLock();
    this.input.clearHeld();
    this.state = 'reward';
    this.audio.play('upgrade');
    this.ui.showRewards(offers, this.run.build.synergies());
  }

  private takeReward(id: string): void {
    if (!this.run.takeReward(id)) return;
    this.audio.play('ui-click');
    this.applyBuildToPlayer();
    if (this.save) this.save.build = this.run.build.toJSON();
    this.persist();
    this.setState('playing');
    this.input.requestLock();
  }

  private skipReward(): void {
    this.run.dismissRewards();
    this.audio.play('ui-back');
    this.setState('playing');
    this.input.requestLock();
  }

  /** Push the run build's stat modifiers into the player. */
  private applyBuildToPlayer(): void {
    const m = this.run.build.modifiers;
    const base = accumulateUpgrades(this.save?.upgrades ?? 0, isConvergence(this.affinity));
    const stats = {
      ...base,
      maxHealth: base.maxHealth + m.maxHealth,
      maxEnergy: base.maxEnergy + m.maxEnergy,
      energyRegen: base.energyRegen + m.energyRegen,
      moveScale: base.moveScale * m.moveScale,
    };
    this.player.applyStats(stats, true);
    this.player.buildArmor = m.armor;
  }

  private onResize(): void {
    this.viewportW = window.innerWidth;
    this.viewportH = window.innerHeight;
    this.renderer.setSize(this.viewportW, this.viewportH);
  }

  dispose(): void {
    this.running = false;
    this.input.detach();
    this.audio.dispose();
    this.enemies.dispose();
    this.projectiles.dispose();
    this.particles.dispose();
    this.shrines.dispose();
    this.flora.dispose();
    this.props.dispose();
    this.water.dispose();
    this.decals.dispose();
    this.telegraphs.dispose();
    this.weather.dispose();
    this.world.dispose();
    this.renderer.dispose();
  }
}
