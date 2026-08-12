/**
 * All DOM interface: screens, HUD, compass, tutorial, toasts and overlays.
 *
 * The game never touches the DOM directly - it pushes a snapshot of state in
 * here once per frame and this module keeps the interface in sync.
 */

import type { AffinityId, ElementId } from '../elements/affinity';
import { ELEMENTS, ELEMENT_ORDER, affinityPresentation, cssColor } from '../elements/elements';
import { materialDef, materialSwatchCSS, type MaterialId } from '../world/materials';
import { SHRINE_COUNT, SHRINE_SITES, type WorldMode } from '../world/shrineData';
import { CONSUMABLES, CONSUMABLE_ORDER, type ConsumableId } from '../player/inventory';
import { formatPlaytime, timeAgo, type QualityPreset, type SaveData, type Settings } from '../save/saveData';
import { RARITY_COLORS } from '../progression/upgrades';
import type { OfferPreview, RewardOffer } from '../progression/rewards';
import { offerSubtitle } from '../progression/rewards';
import type { ChestOutcome } from '../progression/chests';
import type { SynergyMatch } from '../progression/BuildState';
import { STATUSES, type StatusId } from '../combat/status';

export type ScreenName =
  | 'title' | 'settings' | 'loading' | 'reveal' | 'pause' | 'death'
  | 'upgrade' | 'victory' | 'confirm' | 'newworld' | 'satchel' | 'reward'
  | 'chest' | 'story' | 'none';

/** One ability slot as the HUD shows it. */
export interface HudAbility {
  name: string;
  input: string;
  /** 0..1 cooldown sweep. */
  cooldown: number;
  /** Seconds of cooldown left, shown as a number. */
  cooldownSeconds: number;
  ready: boolean;
  /** Mana cost, or 0 for the Ultimate. */
  cost: number;
  affordable: boolean;
}

export interface HudState {
  health: number;
  maxHealth: number;
  energy: number;
  maxEnergy: number;
  affinity: AffinityId;
  activeElement: ElementId;
  mode: 'element' | 'terrain';
  worldMode: WorldMode;
  primaryCd: number;
  secondaryCd: number;
  primaryReady: boolean;
  secondaryReady: boolean;
  /** Every active ability, in HUD order. */
  abilities: HudAbility[];
  /** 0..1 Ultimate meter. */
  ultimateCharge: number;
  ultimateReady: boolean;
  ultimateUnlocked: boolean;
  /** Mana bar state, drives the low / paused / resting styling. */
  manaState: 'normal' | 'low' | 'empty' | 'paused' | 'resting' | 'free';
  /** True while the element's terrain is boosting Mana regeneration. */
  manaTerrainBonus: boolean;
  /** 0..1 oxygen, only shown while submerged. */
  oxygen: number;
  submerged: boolean;
  /** Active blessings and penalties. */
  buffs: { name: string; color: number; fraction: number; penalty: boolean }[];
  /** How many permanent upgrades the build holds. */
  permanentUpgrades: number;
  /** Name of the current world. */
  worldName: string;
  /** The current story objective line. */
  objective: string;
  shrinesCleansed: number;
  yaw: number;
  playerX: number;
  /** Where the lit World Beacon stands, or null while the world is unfinished. */
  beacon: { x: number; z: number } | null;
  playerZ: number;
  shrineFlags: readonly boolean[];
  passive: string | null;
  /** Terrain hotbar. */
  materials: { id: MaterialId; amount: number; locked: boolean }[];
  materialSelected: number;
  brushRadius: number;
  brushFine: boolean;
  switchLocked: boolean;
  /** Healing readouts. */
  regenActive: boolean;
  effect: { id: ConsumableId; fraction: number } | null;
  potionCooldown: number;
  potionCooldownMax: number;
  items: { id: ConsumableId; count: number }[];
  breath: number;
  maxBreath: number;
}

export interface MenuCallbacks {
  onContinue(): void;
  onNewWorld(): void;
  onCreateWorld(mode: WorldMode): void;
  onDeleteSave(): void;
  onOpenSettings(): void;
  onCloseSettings(): void;
  onResetSettings(): void;
  onSettingChange(patch: Partial<Settings>): void;
  onQualityPreset(preset: QualityPreset): void;
  onResume(): void;
  onQuitToTitle(): void;
  onReplayTutorial(): void;
  onToggleWorldMode(): void;
  onRespawn(): void;
  onRevealContinue(): void;
  onUpgradeContinue(): void;
  onVictoryContinue(): void;
  onVictoryNewWorld(): void;
  onCancelConfirm(): void;
  onUseItem(id: ConsumableId): void;
  onCloseSatchel(): void;
  onTakeReward(id: string): void;
  onSkipReward(): void;
  onCloseChest(): void;
  onCloseStory(): void;
  onAnyInteraction(): void;
}

interface TutorialStep {
  text: string;
  done: boolean;
}

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`UI element #${id} is missing from index.html`);
  return node as T;
}

/** What the last hit did. Drives the crosshair confirmation shape. */
export type HitConfirmKind =
  | 'normal' | 'crit' | 'status' | 'blocked' | 'resist' | 'immune' | 'kill';

/** Pre-fire aim state shown on the crosshair every frame. */
export type CrosshairState =
  | 'neutral' | 'target' | 'blocked' | 'cooldown' | 'no-energy' | 'invalid';

const HIT_CONFIRM_CLASSES = [
  'x-normal', 'x-crit', 'x-status', 'x-blocked', 'x-resist', 'x-immune', 'x-kill',
] as const;

const HIT_CONFIRM_HOLD: Record<HitConfirmKind, number> = {
  normal: 110, crit: 190, status: 150, blocked: 160, resist: 160, immune: 220, kill: 300,
};

const CROSSHAIR_STATES = [
  'neutral', 'target', 'blocked', 'cooldown', 'no-energy', 'invalid',
] as const;

/** Stable node ids so the game can flash a specific ability slot. */
const ABILITY_NODE_IDS = [
  'ability-primary', 'ability-secondary', 'ability-technique', 'ability-ultimate',
];

export class UI {
  private hitConfirmTimer = 0;
  private screens: Record<Exclude<ScreenName, 'none'>, HTMLElement>;
  private current: ScreenName = 'none';
  private hud = el<HTMLElement>('hud');
  private callbacks: MenuCallbacks | null = null;

  private revealAnim = 0;
  private revealCtx: CanvasRenderingContext2D | null = null;
  private revealParticles: { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number }[] = [];
  private revealColor = '#b8ecff';

  private confirmAction: (() => void) | null = null;
  private vignetteTimer = 0;
  private flashTimer = 0;
  private healFlashTimer = 0;
  private compassMarks: HTMLElement[] = [];
  /** The compass mark for the World Beacon, shown once a world is finished. */
  private beaconMark: HTMLElement | null = null;
  private lastMaterialSignature = '';
  private lastItemSignature = '';
  private tutorialSteps: TutorialStep[] = [];
  private tutorialTitle = 'First steps';
  private newWorldMode: WorldMode = 'normal';
  /** Which reward card the keyboard is on. */
  private rewardFocus = 0;
  private storyBannerTimer = 0;
  private lastAbilitySignature = '';
  private lastBuffSignature = '';

  constructor() {
    this.screens = {
      title: el('screen-title'),
      settings: el('screen-settings'),
      loading: el('screen-loading'),
      reveal: el('screen-reveal'),
      pause: el('screen-pause'),
      death: el('screen-death'),
      upgrade: el('screen-upgrade'),
      victory: el('screen-victory'),
      confirm: el('screen-confirm'),
      newworld: el('screen-newworld'),
      satchel: el('screen-satchel'),
      reward: el('screen-reward'),
      chest: el('screen-chest'),
      story: el('screen-story'),
    };
    this.buildCompassTicks();
    this.buildElementRail('air', false);
  }

  // ------------------------------------------------------------- binding

  bind(callbacks: MenuCallbacks): void {
    this.callbacks = callbacks;

    const click = (id: string, fn: () => void): void => {
      const node = el<HTMLButtonElement>(id);
      node.addEventListener('click', () => {
        callbacks.onAnyInteraction();
        fn();
      });
      node.addEventListener('mouseenter', () => callbacks.onAnyInteraction());
    };

    click('btn-continue', () => callbacks.onContinue());
    click('btn-new', () => callbacks.onNewWorld());
    click('btn-settings', () => callbacks.onOpenSettings());
    click('btn-delete', () => callbacks.onDeleteSave());
    click('btn-settings-back', () => callbacks.onCloseSettings());
    click('btn-settings-reset', () => callbacks.onResetSettings());
    click('btn-resume', () => callbacks.onResume());
    click('btn-pause-settings', () => callbacks.onOpenSettings());
    click('btn-pause-tutorial', () => callbacks.onReplayTutorial());
    click('btn-pause-mode', () => callbacks.onToggleWorldMode());
    click('btn-pause-title', () => callbacks.onQuitToTitle());
    click('btn-respawn', () => callbacks.onRespawn());
    click('btn-reveal-continue', () => callbacks.onRevealContinue());
    click('btn-upgrade-continue', () => callbacks.onUpgradeContinue());
    click('btn-victory-continue', () => callbacks.onVictoryContinue());
    click('btn-victory-new', () => callbacks.onVictoryNewWorld());
    click('btn-satchel-close', () => callbacks.onCloseSatchel());
    click('btn-reward-skip', () => callbacks.onSkipReward());
    click('btn-chest-close', () => callbacks.onCloseChest());
    click('btn-story-close', () => callbacks.onCloseStory());
    click('btn-confirm-no', () => {
      this.confirmAction = null;
      callbacks.onCancelConfirm();
    });
    click('btn-confirm-yes', () => {
      const action = this.confirmAction;
      this.confirmAction = null;
      action?.();
    });

    // --- New World mode picker
    click('btn-mode-normal', () => this.setNewWorldMode('normal'));
    click('btn-mode-peaceful', () => this.setNewWorldMode('peaceful'));
    click('btn-newworld-start', () => callbacks.onCreateWorld(this.newWorldMode));
    click('btn-newworld-back', () => callbacks.onCancelConfirm());

    el<HTMLButtonElement>('tut-dismiss').addEventListener('click', () => {
      callbacks.onAnyInteraction();
      this.dismissTutorial();
    });

    // --- quality presets
    for (const preset of ['low', 'medium', 'high'] as const) {
      click(`btn-quality-${preset}`, () => callbacks.onQualityPreset(preset));
    }

    const slider = (id: string, out: string, format: (v: number) => string, apply: (v: number) => Partial<Settings>): void => {
      const input = el<HTMLInputElement>(id);
      const output = el<HTMLOutputElement>(out);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        output.textContent = format(v);
        callbacks.onSettingChange(apply(v));
      });
    };
    slider('set-sens', 'out-sens', (v) => v.toFixed(2), (v) => ({ sensitivity: v }));
    slider('set-fov', 'out-fov', (v) => `${v.toFixed(0)}°`, (v) => ({ fov: v }));
    slider('set-render', 'out-render', (v) => `${v.toFixed(0)}`, (v) => ({ renderDistance: v }));
    slider('set-terrain', 'out-terrain', (v) => `${Math.round(v * 100)}%`, (v) => ({ terrainDetail: v }));
    slider('set-particles', 'out-particles', (v) => `${Math.round(v * 100)}%`, (v) => ({ particleDensity: v }));
    slider('set-shadowq', 'out-shadowq', (v) => ['Off', 'Low', 'High'][Math.round(v)] ?? '', (v) => ({ shadowQuality: Math.round(v) }));
    slider('set-master', 'out-master', (v) => `${Math.round(v * 100)}%`, (v) => ({ masterVolume: v }));
    slider('set-sfx', 'out-sfx', (v) => `${Math.round(v * 100)}%`, (v) => ({ sfxVolume: v }));
    slider('set-amb', 'out-amb', (v) => `${Math.round(v * 100)}%`, (v) => ({ ambienceVolume: v }));

    const toggle = (id: string, apply: (v: boolean) => Partial<Settings>): void => {
      const input = el<HTMLInputElement>(id);
      input.addEventListener('change', () => {
        callbacks.onAnyInteraction();
        callbacks.onSettingChange(apply(input.checked));
      });
    };
    toggle('set-mute', (v) => ({ muted: v }));
    toggle('set-shadows', (v) => ({ shadows: v }));
    toggle('set-post', (v) => ({ postProcessing: v }));
    toggle('set-aa', (v) => ({ antialias: v }));
    toggle('set-reduce-flash', (v) => ({ reducedFlashes: v }));
    toggle('set-reduce-shake', (v) => ({ reducedShake: v }));
    toggle('set-reduce-distort', (v) => ({ reducedDistortion: v }));
    toggle('set-reduce-particles', (v) => ({ reducedParticles: v }));

    // Reward cards support the keyboard as well as the mouse: 1-3 or the arrow
    // keys move the focus, Enter takes the focused card.
    window.addEventListener('keydown', (e) => {
      if (this.current !== 'reward') return;
      const cards = [...el<HTMLElement>('reward-cards').querySelectorAll<HTMLButtonElement>('.reward-card')];
      if (cards.length === 0) return;
      if (e.code.startsWith('Digit')) {
        const index = Number(e.code.slice(5)) - 1;
        if (index >= 0 && index < cards.length) {
          e.preventDefault();
          cards[index]!.focus();
          this.setRewardFocus(index);
        }
        return;
      }
      if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
        e.preventDefault();
        const step = e.code === 'ArrowRight' ? 1 : -1;
        const next = (this.rewardFocus + step + cards.length) % cards.length;
        cards[next]!.focus();
        this.setRewardFocus(next);
        return;
      }
      if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        cards[this.rewardFocus]?.click();
      }
    });
  }

  private setRewardFocus(index: number): void {
    this.rewardFocus = index;
    const cards = [...el<HTMLElement>('reward-cards').querySelectorAll<HTMLElement>('.reward-card')];
    cards.forEach((card, i) => card.classList.toggle('focused', i === index));
    this.callbacks?.onAnyInteraction();
  }

  // ------------------------------------------------------------- screens

  showScreen(name: ScreenName): void {
    for (const [key, node] of Object.entries(this.screens)) {
      node.classList.toggle('hidden', key !== name);
    }
    this.current = name;
    this.hud.classList.toggle('hidden', name !== 'none' && name !== 'satchel');
    if (name === 'reveal') this.startRevealAnimation();
    if (name === 'victory') this.startVictoryAnimation();
  }

  get screen(): ScreenName {
    return this.current;
  }

  setLoading(progress: number, note: string, title?: string): void {
    // A load can be a fresh world, a Continue or a step through the Beacon, and
    // the destination is the one thing a waiting player wants to see. The title
    // was fixed in the markup and named the first world whichever one was
    // actually being built.
    const fraction = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
    el<HTMLElement>('loading-fill').style.width = `${Math.round(fraction * 100)}%`;
    el<HTMLElement>('loading-note').textContent = note;
    if (title) el<HTMLElement>('loading-title').textContent = title;
  }

  setNewWorldMode(mode: WorldMode): void {
    this.newWorldMode = mode;
    el<HTMLElement>('btn-mode-normal').classList.toggle('selected', mode === 'normal');
    el<HTMLElement>('btn-mode-peaceful').classList.toggle('selected', mode === 'peaceful');
    el<HTMLElement>('newworld-desc').textContent = mode === 'peaceful'
      ? 'No hostile creatures anywhere in the world. Shrines are cleansed by gathering three elemental motes instead of felling a guardian. Falling and drowning can still hurt you.'
      : 'Corrupted creatures roam the Verdance and a guardian defends every shrine. The full challenge.';
  }

  get selectedNewWorldMode(): WorldMode {
    return this.newWorldMode;
  }

  setContinueInfo(save: SaveData | null): void {
    const card = el<HTMLElement>('continue-card');
    const btn = el<HTMLElement>('btn-continue');
    const del = el<HTMLElement>('btn-delete');
    if (!save) {
      card.classList.add('hidden');
      btn.classList.add('hidden');
      del.classList.add('hidden');
      return;
    }
    card.classList.remove('hidden');
    btn.classList.remove('hidden');
    del.classList.remove('hidden');
    el<HTMLElement>('cc-seed').textContent = String(save.seed);
    el<HTMLElement>('cc-affinity').textContent = affinityPresentation(save.affinity).title;
    el<HTMLElement>('cc-mode').textContent = save.worldMode === 'peaceful' ? 'Peaceful' : 'Normal';
    el<HTMLElement>('cc-shrines').textContent = `${save.shrines.filter(Boolean).length} / ${SHRINE_COUNT}`;
    el<HTMLElement>('cc-time').textContent = `${timeAgo(save.updatedAt)} · ${formatPlaytime(save.playtime)} played`;
  }

  setPauseInfo(seed: number, affinity: AffinityId, cleansed: number, mode: WorldMode): void {
    el<HTMLElement>('pause-seed').textContent = String(seed);
    el<HTMLElement>('pause-affinity').textContent = affinityPresentation(affinity).title;
    el<HTMLElement>('pause-shrines').textContent = `${cleansed} / ${SHRINE_COUNT}`;
    el<HTMLElement>('pause-mode').textContent = mode === 'peaceful' ? 'Peaceful' : 'Normal';
    el<HTMLElement>('btn-pause-mode').textContent = mode === 'peaceful'
      ? 'Switch to Normal Mode'
      : 'Switch to Peaceful Mode';
  }

  askConfirm(title: string, body: string, action: () => void, confirmLabel = 'Confirm'): void {
    el<HTMLElement>('confirm-title').textContent = title;
    el<HTMLElement>('confirm-body').textContent = body;
    el<HTMLElement>('btn-confirm-yes').textContent = confirmLabel;
    this.confirmAction = action;
    this.showScreen('confirm');
  }

  syncSettings(settings: Settings): void {
    const set = (id: string, out: string, value: number, format: (v: number) => string): void => {
      el<HTMLInputElement>(id).value = String(value);
      el<HTMLOutputElement>(out).textContent = format(value);
    };
    set('set-sens', 'out-sens', settings.sensitivity, (v) => v.toFixed(2));
    set('set-fov', 'out-fov', settings.fov, (v) => `${v.toFixed(0)}°`);
    set('set-render', 'out-render', settings.renderDistance, (v) => `${v.toFixed(0)}`);
    set('set-terrain', 'out-terrain', settings.terrainDetail, (v) => `${Math.round(v * 100)}%`);
    set('set-particles', 'out-particles', settings.particleDensity, (v) => `${Math.round(v * 100)}%`);
    set('set-shadowq', 'out-shadowq', settings.shadowQuality, (v) => ['Off', 'Low', 'High'][Math.round(v)] ?? '');
    set('set-master', 'out-master', settings.masterVolume, (v) => `${Math.round(v * 100)}%`);
    set('set-sfx', 'out-sfx', settings.sfxVolume, (v) => `${Math.round(v * 100)}%`);
    set('set-amb', 'out-amb', settings.ambienceVolume, (v) => `${Math.round(v * 100)}%`);
    el<HTMLInputElement>('set-mute').checked = settings.muted;
    el<HTMLInputElement>('set-shadows').checked = settings.shadows;
    el<HTMLInputElement>('set-post').checked = settings.postProcessing;
    el<HTMLInputElement>('set-aa').checked = settings.antialias;
    el<HTMLInputElement>('set-reduce-flash').checked = settings.reducedFlashes;
    el<HTMLInputElement>('set-reduce-shake').checked = settings.reducedShake;
    el<HTMLInputElement>('set-reduce-distort').checked = settings.reducedDistortion;
    el<HTMLInputElement>('set-reduce-particles').checked = settings.reducedParticles;
    for (const preset of ['low', 'medium', 'high'] as const) {
      el<HTMLElement>(`btn-quality-${preset}`).classList.toggle('selected', settings.quality === preset);
    }
  }

  // ------------------------------------------------------- affinity theme

  applyTheme(affinity: AffinityId, active: ElementId): void {
    const pres = affinity === 'convergence' ? affinityPresentation('convergence') : affinityPresentation(affinity);
    const el0 = ELEMENTS[active];
    const root = document.documentElement;
    root.style.setProperty('--accent', cssColor(affinity === 'convergence' ? el0.color : pres.color));
    root.style.setProperty('--accent-deep', cssColor(affinity === 'convergence' ? el0.deep : pres.deep));
    this.buildElementRail(active, affinity === 'convergence');
    // The ability rail is rebuilt from the HUD state every frame, so switching
    // element only has to invalidate its signature.
    this.lastAbilitySignature = '';
    void el0;
  }

  private buildElementRail(active: ElementId, convergence: boolean): void {
    const rail = el<HTMLElement>('element-rail');
    rail.innerHTML = '';
    const list: ElementId[] = convergence ? [...ELEMENT_ORDER] : [active];
    for (const id of list) {
      const def = ELEMENTS[id];
      const chip = document.createElement('div');
      chip.className = `el-chip${id === active ? ' active' : ''}`;
      chip.style.setProperty('--el', cssColor(def.color));
      chip.innerHTML = `<svg class="ico"><use href="${def.symbol}" /></svg>${convergence ? `<b>${def.hotkey}</b>` : ''}`;
      chip.title = def.name;
      rail.appendChild(chip);
    }
  }

  // ----------------------------------------------------------------- HUD

  updateHud(state: HudState): void {
    const healthPct = Math.max(0, Math.min(1, state.health / state.maxHealth));
    const energyPct = Math.max(0, Math.min(1, state.energy / state.maxEnergy));
    const healthBar = el<HTMLElement>('health-fill');
    healthBar.style.width = `${healthPct * 100}%`;
    el<HTMLElement>('health-text').textContent = `${Math.ceil(state.health)} / ${Math.round(state.maxHealth)}`;
    const healthWrap = healthBar.parentElement!;
    healthWrap.classList.toggle('low', healthPct < 0.3);
    healthWrap.classList.toggle('regen', state.regenActive);
    healthWrap.classList.toggle('healing', state.effect !== null);

    const energyBar = el<HTMLElement>('energy-fill');
    energyBar.style.width = `${energyPct * 100}%`;
    el<HTMLElement>('energy-text').textContent = `${Math.round(state.energy)} / ${Math.round(state.maxEnergy)}`;
    const energyWrap = energyBar.parentElement!;
    for (const cls of ['mana-low', 'mana-empty', 'mana-paused', 'mana-resting', 'mana-free']) {
      energyWrap.classList.remove(cls);
    }
    if (state.manaState !== 'normal') energyWrap.classList.add(`mana-${state.manaState}`);
    energyWrap.classList.toggle('mana-terrain', state.manaTerrainBonus);

    // ---- oxygen appears only while the head is under a fluid
    const breathWrap = el<HTMLElement>('breath-bar');
    breathWrap.classList.toggle('hidden', !state.submerged);
    if (state.submerged) {
      const frac = Math.max(0, Math.min(1, state.oxygen));
      el<HTMLElement>('breath-fill').style.width = `${frac * 100}%`;
      breathWrap.classList.toggle('critical', frac < 0.25);
      breathWrap.querySelector('span')!.textContent = frac <= 0
        ? 'Drowning'
        : `Oxygen ${Math.ceil(frac * state.maxBreath)}s`;
    }

    // ---- ultimate meter
    const ult = el<HTMLElement>('ultimate-meter');
    ult.classList.toggle('hidden', !state.ultimateUnlocked);
    if (state.ultimateUnlocked) {
      el<HTMLElement>('ultimate-fill').style.width = `${Math.round(state.ultimateCharge * 100)}%`;
      ult.classList.toggle('ready', state.ultimateReady);
      ult.querySelector('span')!.textContent = state.ultimateReady
        ? 'Ultimate ready · MMB / R'
        : `Ultimate ${Math.round(state.ultimateCharge * 100)}%`;
    }

    el<HTMLElement>('objective-text').textContent = state.objective;
    el<HTMLElement>('world-name').textContent = state.worldName;
    const modeTagWorld = el<HTMLElement>('world-mode-tag');
    modeTagWorld.textContent = state.worldMode === 'peaceful' ? 'Peaceful' : 'Normal';
    modeTagWorld.classList.toggle('peaceful', state.worldMode === 'peaceful');

    this.updateAbilityRail(state);
    this.updateBuffStrip(state);

    const modeTag = el<HTMLElement>('mode-tag');
    modeTag.querySelector('span')!.textContent = state.mode === 'terrain' ? 'Terrain Mode' : 'Element Mode';
    modeTag.querySelector('use')!.setAttribute('href', state.mode === 'terrain' ? '#sym-brush' : '#sym-primary');
    el<HTMLElement>('terrain-bar').classList.toggle('hidden', state.mode !== 'terrain');
    el<HTMLElement>('ability-rail').classList.toggle('hidden', state.mode === 'terrain');
    if (state.mode === 'terrain') this.updateTerrainBar(state);

    const chips = el<HTMLElement>('element-rail').children;
    if (state.affinity === 'convergence') {
      for (let i = 0; i < chips.length; i++) {
        const chip = chips[i] as HTMLElement;
        chip.classList.toggle('active', ELEMENT_ORDER[i] === state.activeElement);
        chip.classList.toggle('locked', state.switchLocked && ELEMENT_ORDER[i] !== state.activeElement);
      }
    }

    const passive = el<HTMLElement>('passive-tag');
    if (state.passive) {
      passive.textContent = state.passive;
      passive.classList.remove('hidden');
    } else {
      passive.classList.add('hidden');
    }

    this.updateHealingRail(state);
    this.updateCompass(state);
  }

  /**
   * Rebuild the ability rail.
   *
   * Every active ability - primary, secondary, technique and Ultimate - shows
   * its name, its input, its Mana cost and its live cooldown. The cost only
   * appears when it is relevant, so the rail stays quiet when it can afford
   * everything.
   */
  private updateAbilityRail(state: HudState): void {
    const rail = el<HTMLElement>('ability-rail');
    const signature = state.abilities.map((a) => `${a.name}:${a.input}:${Math.round(a.cost)}`).join('|');
    if (signature !== this.lastAbilitySignature) {
      this.lastAbilitySignature = signature;
      rail.innerHTML = '';
      for (const ability of state.abilities) {
        const node = document.createElement('div');
        node.className = 'ability';
        node.id = ABILITY_NODE_IDS[state.abilities.indexOf(ability)] ?? '';
        node.innerHTML =
          '<div class="cd-sweep"></div>'
          + `<span class="ability-key">${ability.input}</span>`
          + `<span class="ability-name">${ability.name}</span>`
          + '<span class="ability-cost"></span>'
          + '<span class="ability-cd"></span>';
        rail.appendChild(node);
      }
    }

    const nodes = rail.children;
    for (let i = 0; i < nodes.length && i < state.abilities.length; i++) {
      const ability = state.abilities[i]!;
      const node = nodes[i] as HTMLElement;
      (node.querySelector('.cd-sweep') as HTMLElement).style.transform = `scaleY(${ability.cooldown})`;
      node.classList.toggle('ready', ability.ready);
      node.classList.toggle('unaffordable', !ability.affordable && ability.cost > 0);
      const cost = node.querySelector('.ability-cost') as HTMLElement;
      cost.textContent = ability.cost > 0 ? `${Math.round(ability.cost)}` : '';
      cost.classList.toggle('hidden', ability.cost <= 0);
      const cd = node.querySelector('.ability-cd') as HTMLElement;
      cd.textContent = ability.cooldownSeconds > 0.05 ? `${ability.cooldownSeconds.toFixed(1)}s` : '';
    }
  }

  /**
   * Buffs and penalties currently on the player.
   *
   * Collapsed to name plus a timer bar; the full numbers live in the pause
   * menu so the HUD never becomes a spreadsheet.
   */
  private updateBuffStrip(state: HudState): void {
    const strip = el<HTMLElement>('buff-strip');
    const signature = state.buffs.map((b) => `${b.name}:${b.penalty ? 1 : 0}`).join('|')
      + `#${state.permanentUpgrades}`;
    if (signature !== this.lastBuffSignature) {
      this.lastBuffSignature = signature;
      strip.innerHTML = state.buffs.map((b) =>
        `<div class="buff-chip${b.penalty ? ' penalty' : ''}" style="--bc:${cssColor(b.color)}">`
        + `<b>${b.name}</b><i></i></div>`).join('')
        + (state.permanentUpgrades > 0
          ? `<div class="buff-chip permanent"><b>${state.permanentUpgrades} permanent</b></div>`
          : '');
    }
    const chips = strip.querySelectorAll<HTMLElement>('.buff-chip i');
    for (let i = 0; i < chips.length && i < state.buffs.length; i++) {
      chips[i]!.style.width = `${Math.max(0, Math.min(1, state.buffs[i]!.fraction)) * 100}%`;
    }
  }

  private updateTerrainBar(state: HudState): void {
    const bar = el<HTMLElement>('material-slots');
    const signature = state.materials.map((s) => `${s.id}:${Math.round(s.amount)}:${s.locked ? 1 : 0}`).join('|')
      + `#${state.materialSelected}`;
    if (signature !== this.lastMaterialSignature) {
      this.lastMaterialSignature = signature;
      bar.innerHTML = '';
      state.materials.forEach((slot, i) => {
        const def = materialDef(slot.id);
        const node = document.createElement('div');
        node.className = `slot${i === state.materialSelected ? ' active' : ''}`
          + `${slot.amount <= 0 ? ' empty' : ''}${slot.locked ? ' locked' : ''}`;
        node.innerHTML =
          `<span class="label">${def.name}</span>` +
          `<span class="swatch" style="background:${materialSwatchCSS(slot.id)}"></span>` +
          `<span class="count">${Math.floor(slot.amount)}</span>`;
        bar.appendChild(node);
      });
    }
    el<HTMLElement>('brush-size').textContent = state.brushRadius.toFixed(1);
    el<HTMLElement>('brush-mode').textContent = state.brushFine ? 'fine' : 'full';
  }

  private updateHealingRail(state: HudState): void {
    const rail = el<HTMLElement>('healing-rail');
    const signature = state.items.map((s) => `${s.id}:${s.count}`).join('|');
    if (signature !== this.lastItemSignature) {
      this.lastItemSignature = signature;
      rail.innerHTML = '';
      for (const slot of state.items) {
        const def = CONSUMABLES[slot.id];
        const node = document.createElement('div');
        node.className = `heal-chip${slot.count === 0 ? ' empty' : ''}`;
        node.style.setProperty('--chip', cssColor(def.color));
        node.innerHTML =
          `<svg class="ico"><use href="${def.symbol}" /></svg><b>${slot.count}</b>`;
        node.title = `${def.name} - ${def.blurb}`;
        rail.appendChild(node);
      }
    }

    const cd = el<HTMLElement>('potion-cd');
    if (state.potionCooldown > 0 && state.potionCooldownMax > 0) {
      cd.classList.remove('hidden');
      cd.style.setProperty('--frac', String(state.potionCooldown / state.potionCooldownMax));
      cd.textContent = `${state.potionCooldown.toFixed(1)}s`;
    } else {
      cd.classList.add('hidden');
    }

    const effect = el<HTMLElement>('heal-effect');
    if (state.effect) {
      const def = CONSUMABLES[state.effect.id];
      effect.classList.remove('hidden');
      effect.style.setProperty('--chip', cssColor(def.color));
      effect.querySelector('span')!.textContent = def.name;
      (effect.querySelector('i') as HTMLElement).style.width = `${Math.max(0, Math.min(1, state.effect.fraction)) * 100}%`;
    } else {
      effect.classList.add('hidden');
    }
  }

  private buildCompassTicks(): void {
    const ticks = el<HTMLElement>('compass-ticks');
    ticks.innerHTML = '';
    const marks = el<HTMLElement>('compass-marks');
    marks.innerHTML = '';
    this.compassMarks = [];
    for (const site of SHRINE_SITES) {
      const node = document.createElement('div');
      node.className = 'compass-mark';
      node.innerHTML = `<svg class="ico"><use href="#sym-shrine" /></svg><em></em>`;
      node.style.color = cssColor(ELEMENTS[site.element].color);
      marks.appendChild(node);
      this.compassMarks.push(node);
    }
    // The Beacon gets its own mark. Without one, a finished world showed four
    // marks all reading "cleansed" and nothing at all pointing at the exit.
    const beacon = document.createElement('div');
    beacon.className = 'compass-mark beacon';
    beacon.innerHTML = '<svg class="ico"><use href="#sym-shrine" /></svg><em>beacon</em>';
    beacon.style.display = 'none';
    marks.appendChild(beacon);
    this.beaconMark = beacon;
  }

  private updateCompass(state: HudState): void {
    const ticks = el<HTMLElement>('compass-ticks');
    const halfFov = 1.05;

    if (ticks.children.length === 0) {
      for (const label of ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']) {
        const node = document.createElement('div');
        node.className = `compass-tick${label.length === 1 ? ' card' : ''}`;
        node.textContent = label;
        ticks.appendChild(node);
      }
    }
    const cardinalAngles = [0, Math.PI / 4, Math.PI / 2, (3 * Math.PI) / 4, Math.PI, -(3 * Math.PI) / 4, -Math.PI / 2, -Math.PI / 4];
    for (let i = 0; i < ticks.children.length; i++) {
      const node = ticks.children[i] as HTMLElement;
      const rel = normaliseAngle(cardinalAngles[i]! + state.yaw);
      if (Math.abs(rel) > halfFov) { node.style.display = 'none'; continue; }
      node.style.display = '';
      node.style.left = `${50 + (rel / halfFov) * 50}%`;
    }

    for (let i = 0; i < SHRINE_SITES.length; i++) {
      const site = SHRINE_SITES[i]!;
      const node = this.compassMarks[i]!;
      const dx = site.x - state.playerX;
      const dz = site.z - state.playerZ;
      const angle = Math.atan2(dx, -dz);
      const rel = normaliseAngle(angle + state.yaw);
      const done = state.shrineFlags[i] === true;
      node.classList.toggle('done', done);
      if (Math.abs(rel) > halfFov) { node.style.display = 'none'; continue; }
      node.style.display = '';
      node.style.left = `${50 + (rel / halfFov) * 50}%`;
      const dist = Math.hypot(dx, dz);
      const label = done ? 'cleansed' : dist < 30 ? 'close' : dist < 80 ? 'nearby' : 'far';
      node.querySelector('em')!.textContent = label;
    }

    // ---- the Beacon, once it is lit.
    const mark = this.beaconMark;
    if (!mark) return;
    if (!state.beacon) {
      mark.style.display = 'none';
      return;
    }
    const bdx = state.beacon.x - state.playerX;
    const bdz = state.beacon.z - state.playerZ;
    const brel = normaliseAngle(Math.atan2(bdx, -bdz) + state.yaw);
    if (Math.abs(brel) > halfFov) {
      mark.style.display = 'none';
      return;
    }
    mark.style.display = '';
    mark.style.left = `${50 + (brel / halfFov) * 50}%`;
    const bdist = Math.round(Math.hypot(bdx, bdz));
    mark.querySelector('em')!.textContent = bdist < 6 ? 'here' : `${bdist}m`;
  }

  // -------------------------------------------------------------- prompts

  setPrompt(text: string | null, key = 'E', progress = 0): void {
    const node = el<HTMLElement>('prompt');
    if (!text) {
      node.classList.add('hidden');
      return;
    }
    node.classList.remove('hidden');
    node.querySelector('b')!.textContent = key;
    node.querySelector('span')!.textContent = text;
    node.classList.toggle('progress-active', progress > 0);
    node.style.background = progress > 0
      ? `linear-gradient(90deg, rgba(120,180,255,0.4) ${progress * 100}%, rgba(10,14,24,0.8) ${progress * 100}%)`
      : '';
  }

  toast(message: string, tone: 'good' | 'warn' | 'bad' | 'plain' = 'plain', hold = 2.6): void {
    const wrap = el<HTMLElement>('toasts');
    const node = document.createElement('div');
    node.className = `toast${tone === 'plain' ? '' : ` ${tone}`}`;
    node.style.setProperty('--hold', `${hold}s`);
    node.textContent = message;
    wrap.appendChild(node);
    window.setTimeout(() => node.remove(), (hold + 0.5) * 1000);
    while (wrap.children.length > 4) wrap.firstChild?.remove();
  }

  hitMarker(crit = false): void {
    this.hitConfirm(crit ? 'crit' : 'normal');
  }

  /**
   * Immediate confirmation of what the last hit actually did.
   *
   * Each outcome gets its own shape, colour and duration so the player can
   * tell a critical from a resisted hit without reading a number.
   */
  hitConfirm(kind: HitConfirmKind): void {
    const ch = el<HTMLElement>('crosshair');
    const hold = HIT_CONFIRM_HOLD[kind];
    for (const other of HIT_CONFIRM_CLASSES) ch.classList.remove(other);
    ch.classList.add(`x-${kind}`);
    window.clearTimeout(this.hitConfirmTimer);
    this.hitConfirmTimer = window.setTimeout(() => ch.classList.remove(`x-${kind}`), hold);
  }

  /** Show or hide the development combat readout. `null` hides it. */
  setCombatDebug(text: string | null): void {
    const node = document.getElementById('combat-debug');
    if (!node) return;
    node.classList.toggle('hidden', text === null);
    if (text !== null) node.textContent = text;
  }

  /** Show or hide the development collision readout. `null` hides it. */
  setCollisionDebug(text: string | null): void {
    const node = document.getElementById('collision-debug');
    if (!node) return;
    node.classList.toggle('hidden', text === null);
    if (text !== null) node.textContent = text;
  }

  /**
   * Persistent aim state, updated every frame.
   *
   * This is the pre-fire half of the contract: before spending energy the
   * player can see whether something is actually targeted, whether the shot is
   * blocked, and why the ability will not fire.
   */
  setCrosshairState(state: CrosshairState): void {
    const ch = el<HTMLElement>('crosshair');
    if (ch.dataset.state === state) return;
    ch.dataset.state = state;
    for (const other of CROSSHAIR_STATES) ch.classList.remove(`aim-${other}`);
    ch.classList.add(`aim-${state}`);
  }

  /**
   * Point an arrow at the source of a hit, or at an attack winding up outside
   * the player's view. `bearing` is 0 straight ahead, positive to the right.
   */
  showDamageArrow(bearing: number, warningOnly = false): void {
    const wrap = el<HTMLElement>('damage-arrows');
    const node = document.createElement('div');
    node.className = `dmg-arrow${warningOnly ? ' warn' : ''}`;
    node.style.transform = `rotate(${bearing}rad)`;
    wrap.appendChild(node);
    window.setTimeout(() => node.remove(), 1200);
    while (wrap.children.length > 5) wrap.firstChild?.remove();
  }

  /** Show which statuses are currently on the player. */
  setStatuses(entries: { id: StatusId; stacks: number }[]): void {
    const strip = el<HTMLElement>('status-strip');
    const signature = entries.map((e) => `${e.id}:${e.stacks}`).join('|');
    if (strip.dataset.sig === signature) return;
    strip.dataset.sig = signature;
    strip.innerHTML = entries.map((e) => {
      const def = STATUSES[e.id];
      return `<div class="status-chip" style="--sc:${cssColor(def.color)}" title="${def.blurb}">`
        + `${def.name}${e.stacks > 1 ? `<b>${e.stacks}</b>` : ''}</div>`;
    }).join('');
  }

  /**
   * Present the reward choices.
   *
   * Each card carries everything the player needs to decide without guessing:
   * the element sigil, the rarity, the exact numbers it will change, its
   * penalties in a distinct warning style, its stack count, its synergy, how
   * long it lasts, and a before/after preview of the stats it moves.
   */
  showRewards(offers: (RewardOffer & { preview: OfferPreview })[], synergies: SynergyMatch[]): void {
    const wrap = el<HTMLElement>('reward-cards');
    wrap.innerHTML = '';
    this.rewardFocus = 0;

    offers.forEach((offer, index) => {
      const def = offer.def;
      const colour = cssColor(RARITY_COLORS[def.rarity]);
      const element = def.element === 'any' ? null : ELEMENTS[def.element];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `reward-card rar-${def.rarity}${def.tradeoff ? ' tradeoff' : ''}${index === 0 ? ' focused' : ''}`;
      card.style.setProperty('--rar', colour);
      card.style.setProperty('--el', cssColor(element ? element.color : RARITY_COLORS[def.rarity]));

      const benefits = offer.preview.benefits
        .map((line) => `<li class="good">${line.text}</li>`).join('');
      const penalties = offer.preview.penalties
        .map((line) => `<li class="bad"><i>!</i>${line.text}</li>`).join('');
      const deltas = offer.preview.deltas
        .map((d) => `<div class="delta${d.better ? ' up' : ' down'}">`
          + `<span>${d.label}</span><em>${d.before}</em><b>→</b><strong>${d.after}</strong></div>`)
        .join('');

      const tags: string[] = [];
      tags.push(`<span class="reward-tag stack">${offer.owned}/${def.maxStacks} stacks</span>`);
      if (offer.synergyHit) tags.push(`<span class="reward-tag syn">synergy · ${offer.synergyHit}</span>`);
      // Every synergy label the card carries, not only the one already matched,
      // so the player can see what it would build toward.
      for (const tag of offer.preview.synergy) {
        if (tag === offer.synergyHit) continue;
        tags.push(`<span class="reward-tag syn-soft">synergy · ${tag}</span>`);
      }
      for (const tag of def.tags) tags.push(`<span class="reward-tag">${tag}</span>`);

      // Requirements and exclusions are part of the decision, so they are on
      // the card rather than discovered afterwards.
      const conditions: string[] = [];
      if (offer.preview.requires.length > 0) {
        conditions.push(`<li class="req">Requires ${offer.preview.requires.join(', ')}</li>`);
      }
      if (offer.preview.incompatible.length > 0) {
        conditions.push(`<li class="excl">Cannot be combined with ${offer.preview.incompatible.join(', ')}</li>`);
      }
      if (offer.owned + 1 >= def.maxStacks) {
        conditions.push(`<li class="req">Taking this reaches the maximum of ${def.maxStacks}</li>`);
      }

      card.innerHTML =
        `<span class="reward-head">`
        + `<svg class="reward-sigil"><use href="${element ? element.symbol : '#sym-convergence'}" /></svg>`
        + `<span class="reward-titles"><b class="reward-name">${def.name}</b>`
        + `<em class="reward-rarity">${offerSubtitle(offer)}</em></span>`
        + `<kbd>${index + 1}</kbd></span>`
        + `<span class="reward-desc">${def.description}</span>`
        + `<ul class="reward-effects">${benefits}${penalties}</ul>`
        + (def.warning && offer.preview.penalties.length > 0
          ? `<span class="reward-warning"><i>⚠</i>${def.warning}</span>` : '')
        + (conditions.length > 0 ? `<ul class="reward-conditions">${conditions.join('')}</ul>` : '')
        + `<span class="reward-element">${element ? `${element.name} compatible` : 'Any element'}`
        + ` · ${offer.preview.duration}</span>`
        + (deltas ? `<div class="reward-preview"><span>Stat preview</span>${deltas}</div>` : '')
        + `<span class="reward-meta">${tags.join('')}</span>`;

      card.addEventListener('click', () => {
        this.callbacks?.onAnyInteraction();
        this.callbacks?.onTakeReward(def.id);
      });
      card.addEventListener('mouseenter', () => this.setRewardFocus(index));
      card.addEventListener('focus', () => this.setRewardFocus(index));
      wrap.appendChild(card);
    });

    const syn = el<HTMLElement>('reward-synergies');
    syn.innerHTML = synergies.length > 0
      ? `Active synergies: ${synergies.map((x) => `<b>${x.tag}</b> (${x.members.length})`).join(' · ')}`
      : 'Pick with the mouse, the number keys, or the arrow keys and Enter.';
    this.showScreen('reward');
    window.setTimeout(() => {
      wrap.querySelector<HTMLButtonElement>('.reward-card')?.focus();
    }, 30);
  }

  /**
   * Show what a chest contained.
   *
   * The card states the rarity, the exact numbers, whether the effect is
   * permanent for this save or temporary, and any downside - a chest reward
   * can never land silently.
   */
  showChest(outcome: ChestOutcome, rarityLabel: string): void {
    const colour = cssColor(RARITY_COLORS[outcome.rarity]);
    const root = el<HTMLElement>('chest-card');
    root.className = `chest-card rar-${outcome.rarity}`;
    root.style.setProperty('--rar', colour);

    el<HTMLElement>('chest-rarity').textContent = rarityLabel;
    el<HTMLElement>('chest-name').textContent = outcome.name;
    el<HTMLElement>('chest-summary').textContent = outcome.summary;
    el<HTMLElement>('chest-icon').querySelector('use')!.setAttribute('href', outcome.symbol);

    const duration = outcome.permanence === 'save'
      ? 'Permanent for this save'
      : outcome.seconds > 0
        ? `Temporary · ${Math.round(outcome.seconds)}s`
        : 'Applied immediately';
    el<HTMLElement>('chest-duration').textContent = duration;
    el<HTMLElement>('chest-duration').classList.toggle('temporary', outcome.permanence !== 'save');

    el<HTMLElement>('chest-effects').innerHTML =
      outcome.benefits.map((l) => `<li class="${l.tone}">${l.text}</li>`).join('')
      + outcome.penalties.map((l) => `<li class="bad"><i>!</i>${l.text}</li>`).join('');

    const warning = el<HTMLElement>('chest-warning');
    warning.classList.toggle('hidden', !outcome.warning);
    if (outcome.warning) warning.innerHTML = `<i>⚠</i>${outcome.warning}`;

    this.showScreen('chest');
  }

  /** A blocking story sequence. */
  showStory(title: string, lines: readonly string[], seen: boolean): void {
    el<HTMLElement>('story-title').textContent = title;
    el<HTMLElement>('story-body').innerHTML = lines.map((l) => `<p>${l}</p>`).join('');
    el<HTMLElement>('btn-story-close').textContent = seen ? 'Skip' : 'Continue';
    this.showScreen('story');
  }

  /** A quiet story banner that never takes control away. */
  showStoryBanner(title: string, text: string, seconds: number): void {
    const node = el<HTMLElement>('story-banner');
    node.innerHTML = `<b>${title}</b><span>${text}</span>`;
    node.classList.remove('hidden');
    this.storyBannerTimer = seconds;
  }

  /** Render the run build into the pause menu. */
  setBuildSummary(
    entries: { name: string; rarity: string; stacks: number; color: number }[],
    paths: { tag: string; weight: number }[],
    synergies: SynergyMatch[],
    caps: { label: string; value: string }[] = [],
  ): void {
    const node = el<HTMLElement>('pause-build');
    if (entries.length === 0) {
      node.innerHTML = '<div class="bp-empty">No rewards taken yet. Defeat an elite or cleanse a shrine.</div>';
      return;
    }
    const rows = entries.map((e) =>
      `<div class="bp-row" style="--rar:${cssColor(e.color)}"><b>${e.name}</b>`
      + `<em>${e.stacks > 1 ? `x${e.stacks}` : e.rarity}</em></div>`).join('');
    const pathLine = paths.length > 0
      ? `<div class="bp-paths">Build path: ${paths.slice(0, 3).map((p) => `<b>${p.tag}</b>`).join(' · ')}</div>`
      : '';
    const synLine = synergies.length > 0
      ? `<div class="bp-paths">Synergies: ${synergies.map((x) => `<b>${x.tag}</b>`).join(' · ')}</div>`
      : '';
    // A ceiling the player has stacked past is stated outright, so the build
    // screen never shows more power than the game is actually applying.
    const capLine = caps.length > 0
      ? `<div class="bp-caps">At maximum: ${caps.map((c) => `<b>${c.label}</b> ${c.value}`).join(' · ')}</div>`
      : '';
    node.innerHTML = rows + pathLine + synLine + capLine;
  }

  damageFlash(strength: number): void {
    this.vignetteTimer = Math.max(this.vignetteTimer, 0.45);
    el<HTMLElement>('fx-vignette').style.opacity = String(Math.min(0.95, strength));
  }

  /** Soft green pulse when a heal lands - distinct from the damage vignette. */
  healFlash(kind: 'regen' | 'food' | 'potion' | 'rest'): void {
    const node = el<HTMLElement>('fx-heal');
    const color = kind === 'potion' ? 'rgba(90, 214, 160, 0.45)'
      : kind === 'food' ? 'rgba(217, 160, 90, 0.35)'
        : kind === 'rest' ? 'rgba(255, 214, 150, 0.5)'
          : 'rgba(120, 220, 190, 0.22)';
    node.style.boxShadow = `inset 0 0 180px ${color}`;
    node.style.opacity = '1';
    this.healFlashTimer = kind === 'regen' ? 0.35 : 0.8;
  }

  elementFlash(color: number, strength: number): void {
    const node = el<HTMLElement>('fx-element-flash');
    node.style.background = `radial-gradient(ellipse at center, transparent 28%, ${cssColor(color)} 135%)`;
    node.style.opacity = String(Math.min(0.55, strength));
    this.flashTimer = 0.22;
  }

  fade(on: boolean): void {
    el<HTMLElement>('fx-fade').classList.toggle('on', on);
  }

  setFps(text: string | null): void {
    const node = el<HTMLElement>('fps');
    node.classList.toggle('hidden', text === null);
    if (text !== null) node.textContent = text;
  }

  tickOverlays(dt: number): void {
    if (this.vignetteTimer > 0) {
      this.vignetteTimer -= dt;
      if (this.vignetteTimer <= 0) el<HTMLElement>('fx-vignette').style.opacity = '0';
    }
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) el<HTMLElement>('fx-element-flash').style.opacity = '0';
    }
    if (this.healFlashTimer > 0) {
      this.healFlashTimer -= dt;
      if (this.healFlashTimer <= 0) el<HTMLElement>('fx-heal').style.opacity = '0';
    }
    if (this.storyBannerTimer > 0) {
      this.storyBannerTimer -= dt;
      if (this.storyBannerTimer <= 0) el<HTMLElement>('story-banner').classList.add('hidden');
    }
    this.tickRevealAnimation(dt);
  }

  setLowHealth(fraction: number): void {
    if (this.vignetteTimer > 0) return;
    const node = el<HTMLElement>('fx-vignette');
    node.style.opacity = fraction < 0.35 ? String((0.35 - fraction) * 1.6) : '0';
  }

  // ------------------------------------------------------------ tutorial

  setTutorial(title: string, steps: TutorialStep[]): void {
    this.tutorialTitle = title;
    this.tutorialSteps = steps;
    this.renderTutorial();
  }

  updateTutorialProgress(doneFlags: boolean[]): void {
    let changed = false;
    for (let i = 0; i < this.tutorialSteps.length; i++) {
      const done = doneFlags[i] === true;
      if (this.tutorialSteps[i]!.done !== done) {
        this.tutorialSteps[i]!.done = done;
        changed = true;
      }
    }
    if (changed) this.renderTutorial();
  }

  private renderTutorial(): void {
    const panel = el<HTMLElement>('tutorial');
    if (this.tutorialSteps.length === 0) {
      panel.classList.add('hidden');
      return;
    }
    panel.classList.remove('hidden');
    el<HTMLElement>('tut-title').textContent = this.tutorialTitle;
    const body = el<HTMLElement>('tut-body');
    body.innerHTML = this.tutorialSteps
      .map((s) => `<div class="tut-step${s.done ? ' done' : ''}"><i></i><span>${s.text}</span></div>`)
      .join('');
  }

  dismissTutorial(): void {
    this.tutorialSteps = [];
    el<HTMLElement>('tutorial').classList.add('hidden');
    this.onTutorialDismissed?.();
  }

  onTutorialDismissed: (() => void) | null = null;

  get tutorialVisible(): boolean {
    return this.tutorialSteps.length > 0;
  }

  // -------------------------------------------------------------- satchel

  showSatchel(
    materials: { id: MaterialId; amount: number }[],
    items: { id: ConsumableId; count: number }[],
    canUse: (id: ConsumableId) => boolean,
  ): void {
    const matList = el<HTMLElement>('satchel-materials');
    matList.innerHTML = materials.map((m) => {
      const def = materialDef(m.id);
      return `<li><span class="swatch" style="background:${materialSwatchCSS(m.id)}"></span>`
        + `<b>${def.name}</b><em>${Math.floor(m.amount)}</em></li>`;
    }).join('') || '<li class="empty-note">Nothing carried yet - excavate some terrain.</li>';

    const itemList = el<HTMLElement>('satchel-items');
    itemList.innerHTML = '';
    for (const slot of items) {
      const def = CONSUMABLES[slot.id];
      const node = document.createElement('button');
      node.type = 'button';
      node.className = `satchel-item${slot.count === 0 ? ' empty' : ''}`;
      node.style.setProperty('--chip', cssColor(def.color));
      node.disabled = slot.count === 0 || !canUse(slot.id);
      node.innerHTML =
        `<svg class="ico"><use href="${def.symbol}" /></svg>`
        + `<span><b>${def.name}</b><em>${def.blurb}</em></span>`
        + `<i>${slot.count}</i>`;
      node.addEventListener('click', () => {
        this.callbacks?.onAnyInteraction();
        this.callbacks?.onUseItem(slot.id);
      });
      itemList.appendChild(node);
    }
    this.showScreen('satchel');
  }

  // -------------------------------------------------------------- reveal

  showReveal(affinity: AffinityId, mode: WorldMode): void {
    const pres = affinityPresentation(affinity);
    el<HTMLElement>('reveal-icon').querySelector('use')!.setAttribute('href', pres.symbol);
    el<HTMLElement>('reveal-name').textContent = pres.title;
    el<HTMLElement>('reveal-desc').textContent = pres.description;
    el<HTMLElement>('reveal-mode').textContent = mode === 'peaceful' ? 'Peaceful world' : 'Normal world';
    el<HTMLElement>('reveal-mode').classList.toggle('peaceful', mode === 'peaceful');
    this.revealColor = cssColor(pres.color);
    document.documentElement.style.setProperty('--accent', cssColor(pres.color));
    document.documentElement.style.setProperty('--accent-deep', cssColor(pres.deep));

    const list = el<HTMLElement>('reveal-abilities');
    const rows: string[] = [];
    if (affinity === 'convergence') {
      rows.push(
        `<li><svg class="ico"><use href="#sym-convergence" /></svg><span><b>Switch elements</b><em>Press 1 Air · 2 Water · 3 Earth · 4 Fire. Only the held element may act.</em></span></li>`,
      );
      for (const id of ELEMENT_ORDER) {
        const def = ELEMENTS[id];
        rows.push(
          `<li><svg class="ico"><use href="${def.symbol}" /></svg><span><b>${def.name}</b><em>${def.primary.name} · ${def.secondary.name} · ${def.passiveName}</em></span></li>`,
        );
      }
    } else {
      const def = ELEMENTS[affinity as ElementId];
      rows.push(
        `<li><svg class="ico"><use href="#sym-primary" /></svg><span><b>${def.primary.name} <em>(left mouse)</em></b><em>${def.primary.blurb}</em></span></li>`,
        `<li><svg class="ico"><use href="#sym-secondary" /></svg><span><b>${def.secondary.name} <em>(right mouse)</em></b><em>${def.secondary.blurb}</em></span></li>`,
        `<li><svg class="ico"><use href="${def.symbol}" /></svg><span><b>${def.passiveName} <em>(passive)</em></b><em>${def.passiveBlurb}</em></span></li>`,
      );
    }
    list.innerHTML = rows.join('');
    this.showScreen('reveal');
  }

  private startRevealAnimation(): void {
    const canvas = el<HTMLCanvasElement>('reveal-canvas');
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    this.revealCtx = canvas.getContext('2d');
    this.revealParticles = [];
    this.revealAnim = 6;
    const cx = canvas.width / 2;
    const cy = canvas.height * 0.36;
    for (let i = 0; i < 260; i++) {
      const a = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 260;
      this.revealParticles.push({
        x: cx, y: cy,
        vx: Math.cos(a) * speed, vy: Math.sin(a) * speed,
        life: 1.2 + Math.random() * 2.4, max: 3.6,
        size: 1 + Math.random() * 3.4,
      });
    }
  }

  private startVictoryAnimation(): void {
    const canvas = el<HTMLCanvasElement>('victory-canvas');
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    this.revealCtx = canvas.getContext('2d');
    this.revealParticles = [];
    this.revealAnim = 14;
    for (let i = 0; i < 340; i++) {
      this.revealParticles.push({
        x: Math.random() * canvas.width,
        y: canvas.height + Math.random() * 200,
        vx: (Math.random() - 0.5) * 30,
        vy: -30 - Math.random() * 70,
        life: 3 + Math.random() * 6, max: 9,
        size: 1 + Math.random() * 3,
      });
    }
    this.revealColor = '#d9a7ff';
  }

  private tickRevealAnimation(dt: number): void {
    if (this.revealAnim <= 0 || !this.revealCtx) return;
    this.revealAnim -= dt;
    const ctx = this.revealCtx;
    const { width, height } = ctx.canvas;
    ctx.clearRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.revealParticles) {
      p.life -= dt;
      if (p.life <= 0) continue;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 0.9 * dt;
      p.vy = p.vy * (1 - 0.9 * dt) + 22 * dt;
      const alpha = Math.max(0, Math.min(1, p.life / p.max)) * 0.85;
      ctx.fillStyle = this.revealColor;
      ctx.globalAlpha = alpha;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  // ------------------------------------------------------------- upgrade

  showUpgrade(title: string, lines: readonly string[], symbol: string, color: number): void {
    el<HTMLElement>('upgrade-title').textContent = title;
    el<HTMLElement>('upgrade-icon').querySelector('use')!.setAttribute('href', symbol);
    document.documentElement.style.setProperty('--accent', cssColor(color));
    el<HTMLElement>('upgrade-list').innerHTML = lines.map((l) => `<li>${l}</li>`).join('');
    this.showScreen('upgrade');
  }

  showVictory(
    affinity: AffinityId, seed: number, mode: WorldMode,
    playtime: number, terrainMoved: number, enemiesFelled: number,
    finalWorld = false,
  ): void {
    const pres = affinityPresentation(affinity);
    const styled = affinity === 'convergence' ? 'a vessel of the Elemental Convergence' : `a ${pres.title}`;
    el<HTMLElement>('victory-desc').textContent = finalWorld
      ? `Every World Heart beats again. As ${styled}, you held the worlds together - and everything you built `
        + 'is yours to keep. Continue exploring, or begin again stronger with the same build.'
      : `The blight is broken on every shrine here. As ${styled}, you carried this world back into the light.`;
    el<HTMLElement>('btn-victory-continue').textContent = finalWorld
      ? 'Continue in the post-game'
      : 'Keep exploring';
    el<HTMLElement>('victory-stats').innerHTML = [
      `<div><b>${formatPlaytime(playtime)}</b><span>Time</span></div>`,
      `<div><b>${Math.round(terrainMoved)}</b><span>Terrain shaped</span></div>`,
      `<div><b>${enemiesFelled}</b><span>Corrupted felled</span></div>`,
      `<div><b>${mode === 'peaceful' ? 'Peaceful' : 'Normal'}</b><span>Mode</span></div>`,
      `<div><b>${seed}</b><span>Seed</span></div>`,
    ].join('');
    this.showScreen('victory');
  }

  showDeath(note: string): void {
    el<HTMLElement>('death-note').textContent = note;
    this.showScreen('death');
  }
}

function normaliseAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

export { CONSUMABLE_ORDER };
