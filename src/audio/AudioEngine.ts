/**
 * Procedural audio. Every sound in Elemental Frontier is synthesised at
 * runtime with the Web Audio API - the project contains no audio files.
 *
 * The context is created lazily and only resumed after a user gesture, which
 * keeps browsers' autoplay policies happy.
 */

export type SoundName =
  | 'ui-hover' | 'ui-click' | 'ui-back'
  | 'reveal-air' | 'reveal-water' | 'reveal-earth' | 'reveal-fire' | 'reveal-convergence'
  | 'mine-tick' | 'block-break' | 'block-place'
  | 'jump' | 'land' | 'hurt' | 'splash' | 'heal'
  | 'enemy-hurt' | 'enemy-die' | 'enemy-attack' | 'enemy-shoot'
  | 'gust' | 'dash' | 'whip' | 'freeze' | 'rock' | 'wall' | 'fireball' | 'flamewave'
  | 'impact' | 'deny' | 'pickup' | 'shrine-wake' | 'shrine-cleanse' | 'upgrade' | 'victory';

interface Volumes {
  master: number;
  sfx: number;
  ambience: number;
  muted: boolean;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private ambGain: GainNode | null = null;
  private ambienceSource: AudioBufferSourceNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private volumes: Volumes = { master: 0.75, sfx: 0.85, ambience: 0.5, muted: false };
  private lastPlay = new Map<string, number>();
  private started = false;

  /** Create/resume the context. Must be called from a user gesture handler. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      this.masterGain = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.ambGain = this.ctx.createGain();
      this.sfxGain.connect(this.masterGain);
      this.ambGain.connect(this.masterGain);
      this.masterGain.connect(this.ctx.destination);
      this.noiseBuffer = this.createNoiseBuffer(2);
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    this.started = true;
  }

  get ready(): boolean {
    return this.started && this.ctx !== null && this.ctx.state === 'running';
  }

  setVolumes(v: Partial<Volumes>): void {
    Object.assign(this.volumes, v);
    this.applyVolumes();
  }

  private applyVolumes(): void {
    if (!this.ctx || !this.masterGain || !this.sfxGain || !this.ambGain) return;
    const t = this.ctx.currentTime;
    const m = this.volumes.muted ? 0 : this.volumes.master;
    this.masterGain.gain.setTargetAtTime(m, t, 0.03);
    this.sfxGain.gain.setTargetAtTime(this.volumes.sfx, t, 0.03);
    this.ambGain.gain.setTargetAtTime(this.volumes.ambience * 0.5, t, 0.05);
  }

  private createNoiseBuffer(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      // light low-pass so the noise reads as wind/earth, not hiss
      last = last * 0.72 + white * 0.28;
      data[i] = last * 1.6;
    }
    return buffer;
  }

  // ------------------------------------------------------------ primitives

  private env(gain: GainNode, t: number, attack: number, decay: number, peak: number): void {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private tone(opts: {
    type?: OscillatorType; freq: number; to?: number; at?: number;
    attack?: number; decay?: number; gain?: number; detune?: number;
  }): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain) return;
    const t = ctx.currentTime + (opts.at ?? 0);
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = opts.type ?? 'sine';
    osc.frequency.setValueAtTime(opts.freq, t);
    if (opts.to !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t + (opts.attack ?? 0.01) + (opts.decay ?? 0.2));
    }
    if (opts.detune) osc.detune.setValueAtTime(opts.detune, t);
    this.env(g, t, opts.attack ?? 0.008, opts.decay ?? 0.2, opts.gain ?? 0.25);
    osc.connect(g);
    g.connect(this.sfxGain);
    osc.start(t);
    osc.stop(t + (opts.attack ?? 0.008) + (opts.decay ?? 0.2) + 0.05);
  }

  private noise(opts: {
    duration?: number; gain?: number; at?: number;
    filter?: BiquadFilterType; freq?: number; toFreq?: number; q?: number;
  }): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain || !this.noiseBuffer) return;
    const t = ctx.currentTime + (opts.at ?? 0);
    const dur = opts.duration ?? 0.25;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = opts.filter ?? 'bandpass';
    filter.frequency.setValueAtTime(opts.freq ?? 900, t);
    if (opts.toFreq !== undefined) filter.frequency.exponentialRampToValueAtTime(Math.max(40, opts.toFreq), t + dur);
    filter.Q.value = opts.q ?? 1.1;
    const g = ctx.createGain();
    this.env(g, t, Math.min(0.04, dur * 0.25), dur, opts.gain ?? 0.2);
    src.connect(filter);
    filter.connect(g);
    g.connect(this.sfxGain);
    src.start(t);
    src.stop(t + dur + 0.08);
  }

  // ---------------------------------------------------------------- play

  /** Play a named sound. `throttle` prevents machine-gunning identical sounds. */
  play(name: SoundName, throttleMs = 0): void {
    if (!this.ctx || this.volumes.muted) return;
    if (this.ctx.state !== 'running') return;
    if (throttleMs > 0) {
      const now = performance.now();
      const last = this.lastPlay.get(name) ?? -1e9;
      if (now - last < throttleMs) return;
      this.lastPlay.set(name, now);
    }
    switch (name) {
      case 'ui-hover': this.tone({ type: 'sine', freq: 620, gain: 0.06, attack: 0.004, decay: 0.07 }); break;
      case 'ui-click':
        this.tone({ type: 'triangle', freq: 480, to: 760, gain: 0.16, attack: 0.005, decay: 0.11 });
        this.tone({ type: 'sine', freq: 960, gain: 0.07, attack: 0.004, decay: 0.09, at: 0.02 });
        break;
      case 'ui-back': this.tone({ type: 'triangle', freq: 520, to: 300, gain: 0.14, decay: 0.13 }); break;

      case 'reveal-air':
        this.noise({ duration: 1.5, gain: 0.16, filter: 'bandpass', freq: 700, toFreq: 2600, q: 0.7 });
        [523, 659, 880, 1175].forEach((f, i) => this.tone({ type: 'sine', freq: f, gain: 0.13, attack: 0.05, decay: 1.1, at: i * 0.13 }));
        break;
      case 'reveal-water':
        this.noise({ duration: 1.3, gain: 0.14, filter: 'lowpass', freq: 1400, toFreq: 350 });
        [392, 523, 587, 784].forEach((f, i) => this.tone({ type: 'sine', freq: f, gain: 0.14, attack: 0.06, decay: 1.2, at: i * 0.15 }));
        break;
      case 'reveal-earth':
        this.noise({ duration: 1.1, gain: 0.24, filter: 'lowpass', freq: 320, toFreq: 90 });
        [98, 147, 196, 294].forEach((f, i) => this.tone({ type: 'triangle', freq: f, gain: 0.18, attack: 0.03, decay: 1.3, at: i * 0.12 }));
        break;
      case 'reveal-fire':
        this.noise({ duration: 1.4, gain: 0.2, filter: 'bandpass', freq: 380, toFreq: 1800, q: 0.6 });
        [220, 277, 330, 440].forEach((f, i) => this.tone({ type: 'sawtooth', freq: f, gain: 0.09, attack: 0.02, decay: 1.1, at: i * 0.1 }));
        break;
      case 'reveal-convergence':
        this.noise({ duration: 2.2, gain: 0.16, filter: 'bandpass', freq: 400, toFreq: 3000, q: 0.5 });
        [261, 329, 392, 523, 659, 784].forEach((f, i) => {
          this.tone({ type: 'sine', freq: f, gain: 0.13, attack: 0.06, decay: 1.7, at: i * 0.14 });
          this.tone({ type: 'triangle', freq: f * 2, gain: 0.05, attack: 0.08, decay: 1.3, at: i * 0.14 + 0.05 });
        });
        break;

      case 'mine-tick': this.noise({ duration: 0.07, gain: 0.11, filter: 'bandpass', freq: 1500, toFreq: 800, q: 2.4 }); break;
      case 'block-break':
        this.noise({ duration: 0.28, gain: 0.3, filter: 'bandpass', freq: 900, toFreq: 220, q: 1.1 });
        this.tone({ type: 'triangle', freq: 180, to: 90, gain: 0.14, decay: 0.2 });
        break;
      case 'block-place':
        this.tone({ type: 'square', freq: 300, to: 190, gain: 0.1, attack: 0.004, decay: 0.09 });
        this.noise({ duration: 0.1, gain: 0.14, filter: 'lowpass', freq: 1100, toFreq: 400 });
        break;

      case 'jump': this.tone({ type: 'sine', freq: 300, to: 520, gain: 0.11, attack: 0.005, decay: 0.13 }); break;
      case 'land': this.noise({ duration: 0.14, gain: 0.16, filter: 'lowpass', freq: 700, toFreq: 180 }); break;
      case 'hurt':
        this.tone({ type: 'sawtooth', freq: 260, to: 90, gain: 0.24, attack: 0.005, decay: 0.3 });
        this.noise({ duration: 0.22, gain: 0.18, filter: 'bandpass', freq: 500, toFreq: 160, q: 0.8 });
        break;
      case 'splash': this.noise({ duration: 0.4, gain: 0.22, filter: 'bandpass', freq: 2200, toFreq: 420, q: 0.7 }); break;
      case 'heal': this.tone({ type: 'sine', freq: 520, to: 880, gain: 0.09, attack: 0.05, decay: 0.5 }); break;

      case 'enemy-hurt': this.tone({ type: 'square', freq: 200, to: 120, gain: 0.13, attack: 0.004, decay: 0.14 }); break;
      case 'enemy-die':
        this.tone({ type: 'sawtooth', freq: 320, to: 60, gain: 0.2, attack: 0.01, decay: 0.55 });
        this.noise({ duration: 0.5, gain: 0.2, filter: 'lowpass', freq: 1600, toFreq: 140 });
        break;
      case 'enemy-attack': this.tone({ type: 'square', freq: 150, to: 320, gain: 0.14, attack: 0.006, decay: 0.16 }); break;
      case 'enemy-shoot': this.tone({ type: 'triangle', freq: 700, to: 340, gain: 0.11, attack: 0.006, decay: 0.24 }); break;

      case 'gust':
        this.noise({ duration: 0.55, gain: 0.3, filter: 'bandpass', freq: 500, toFreq: 2800, q: 0.55 });
        this.tone({ type: 'sine', freq: 900, to: 1700, gain: 0.06, attack: 0.02, decay: 0.4 });
        break;
      case 'dash':
        this.noise({ duration: 0.32, gain: 0.28, filter: 'highpass', freq: 400, toFreq: 2400 });
        this.tone({ type: 'sine', freq: 620, to: 1500, gain: 0.09, attack: 0.008, decay: 0.28 });
        break;
      case 'whip':
        this.noise({ duration: 0.3, gain: 0.24, filter: 'bandpass', freq: 1800, toFreq: 500, q: 1.4 });
        this.tone({ type: 'sine', freq: 480, to: 220, gain: 0.11, attack: 0.006, decay: 0.24 });
        break;
      case 'freeze':
        this.tone({ type: 'sine', freq: 1400, to: 2600, gain: 0.13, attack: 0.02, decay: 0.5 });
        this.tone({ type: 'triangle', freq: 700, to: 1300, gain: 0.08, attack: 0.03, decay: 0.6 });
        this.noise({ duration: 0.6, gain: 0.14, filter: 'highpass', freq: 2000, toFreq: 5200 });
        break;
      case 'rock':
        this.tone({ type: 'triangle', freq: 150, to: 70, gain: 0.24, attack: 0.008, decay: 0.32 });
        this.noise({ duration: 0.3, gain: 0.2, filter: 'lowpass', freq: 900, toFreq: 200 });
        break;
      case 'wall':
        this.tone({ type: 'triangle', freq: 90, to: 180, gain: 0.26, attack: 0.03, decay: 0.6 });
        this.noise({ duration: 0.65, gain: 0.26, filter: 'lowpass', freq: 420, toFreq: 130 });
        break;
      case 'fireball':
        this.noise({ duration: 0.36, gain: 0.24, filter: 'bandpass', freq: 320, toFreq: 1500, q: 0.7 });
        this.tone({ type: 'sawtooth', freq: 260, to: 620, gain: 0.1, attack: 0.008, decay: 0.28 });
        break;
      case 'flamewave':
        this.noise({ duration: 0.9, gain: 0.32, filter: 'bandpass', freq: 260, toFreq: 1900, q: 0.5 });
        this.tone({ type: 'sawtooth', freq: 160, to: 420, gain: 0.13, attack: 0.03, decay: 0.75 });
        break;

      case 'impact':
        this.tone({ type: 'triangle', freq: 220, to: 80, gain: 0.2, attack: 0.004, decay: 0.22 });
        this.noise({ duration: 0.2, gain: 0.2, filter: 'lowpass', freq: 1400, toFreq: 260 });
        break;
      case 'deny': this.tone({ type: 'square', freq: 220, to: 150, gain: 0.1, attack: 0.005, decay: 0.12 }); break;
      case 'pickup':
        this.tone({ type: 'sine', freq: 780, to: 1180, gain: 0.1, attack: 0.005, decay: 0.16 });
        break;
      case 'shrine-wake':
        this.tone({ type: 'sawtooth', freq: 70, to: 130, gain: 0.22, attack: 0.2, decay: 1.4 });
        this.noise({ duration: 1.6, gain: 0.2, filter: 'lowpass', freq: 260, toFreq: 900 });
        break;
      case 'shrine-cleanse':
        [261, 329, 392, 523, 659].forEach((f, i) => {
          this.tone({ type: 'sine', freq: f, gain: 0.16, attack: 0.05, decay: 1.6, at: i * 0.11 });
          this.tone({ type: 'triangle', freq: f * 2, gain: 0.06, attack: 0.08, decay: 1.2, at: i * 0.11 + 0.04 });
        });
        this.noise({ duration: 1.8, gain: 0.18, filter: 'highpass', freq: 600, toFreq: 4200 });
        break;
      case 'upgrade':
        [392, 523, 659, 784].forEach((f, i) => this.tone({ type: 'sine', freq: f, gain: 0.15, attack: 0.02, decay: 0.7, at: i * 0.08 }));
        break;
      case 'victory':
        [261, 329, 392, 523, 659, 784, 1046].forEach((f, i) => {
          this.tone({ type: 'sine', freq: f, gain: 0.16, attack: 0.03, decay: 2.2, at: i * 0.17 });
          this.tone({ type: 'triangle', freq: f * 1.5, gain: 0.07, attack: 0.05, decay: 1.6, at: i * 0.17 + 0.06 });
        });
        break;
      default: break;
    }
  }

  /** Looping wind-and-water bed that plays while the player is in the world. */
  startAmbience(): void {
    if (!this.ctx || !this.ambGain || !this.noiseBuffer || this.ambienceSource) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 0.4;
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    const g = ctx.createGain();
    g.gain.value = 0.5;
    src.connect(filter);
    filter.connect(g);
    g.connect(this.ambGain);
    src.start();
    lfo.start();
    this.ambienceSource = src;
  }

  stopAmbience(): void {
    if (!this.ambienceSource) return;
    try {
      this.ambienceSource.stop();
    } catch {
      /* already stopped */
    }
    this.ambienceSource.disconnect();
    this.ambienceSource = null;
  }

  dispose(): void {
    this.stopAmbience();
    if (this.ctx) void this.ctx.close();
    this.ctx = null;
    this.masterGain = null;
    this.sfxGain = null;
    this.ambGain = null;
    this.noiseBuffer = null;
    this.started = false;
  }
}
