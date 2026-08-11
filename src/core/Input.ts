/**
 * Keyboard / mouse input with pointer lock.
 *
 * Keeps a snapshot of held keys plus per-frame "pressed this frame" edges so
 * gameplay code never has to wire its own listeners.
 */

export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  private mouseHeld = new Set<number>();
  private mousePressed = new Set<number>();
  private mouseReleased = new Set<number>();

  mouseDX = 0;
  mouseDY = 0;
  wheelDelta = 0;
  locked = false;
  sensitivity = 1;

  /**
   * Middle-button clicks and wheel notches this frame.
   *
   * Kept as two separate counters on purpose: the Ultimate reads
   * `middleClicks`, terrain material cycling reads `wheelDelta`, and scrolling
   * the wheel can therefore never trigger an Ultimate.
   */
  middleClicks = 0;
  wheelEvents = 0;

  /** Called when pointer lock is lost so the game can pause. */
  onPointerLockLost: (() => void) | null = null;
  /** Called with the raw event on any key press (used for menu shortcuts). */
  onKeyDown: ((code: string) => void) | null = null;

  private readonly element: HTMLElement;
  private bound = false;

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) {
      this.onKeyDown?.(e.code);
      return;
    }
    this.held.add(e.code);
    this.pressed.add(e.code);
    this.onKeyDown?.(e.code);
    // Stop the browser scrolling / tab-cycling while playing.
    if (['Space', 'Tab', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
      e.preventDefault();
    }
  };

  private readonly handleKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
    this.released.add(e.code);
  };

  private readonly handleMouseDown = (e: MouseEvent): void => {
    if (!this.locked) return;
    // Button 1 is the middle *click*. It is a completely separate input from
    // wheel scrolling, which arrives through `handleWheel` and only ever
    // changes `wheelDelta` - so the Ultimate can never fire from a scroll.
    if (e.button === 1) {
      e.preventDefault();
      this.middleClicks++;
    }
    this.mouseHeld.add(e.button);
    this.mousePressed.add(e.button);
  };

  private readonly handleAuxClick = (e: MouseEvent): void => {
    // Stops the browser's middle-click autoscroll from hijacking the button.
    if (e.button === 1) e.preventDefault();
  };

  private readonly handleMouseUp = (e: MouseEvent): void => {
    this.mouseHeld.delete(e.button);
    this.mouseReleased.add(e.button);
  };

  private readonly handleMouseMove = (e: MouseEvent): void => {
    if (!this.locked) return;
    this.mouseDX += e.movementX * 0.0022 * this.sensitivity;
    this.mouseDY += e.movementY * 0.0022 * this.sensitivity;
  };

  private readonly handleWheel = (e: WheelEvent): void => {
    if (!this.locked) return;
    this.wheelDelta += e.deltaY;
    this.wheelEvents++;
    e.preventDefault();
  };

  private readonly handleLockChange = (): void => {
    const nowLocked = document.pointerLockElement === this.element;
    const wasLocked = this.locked;
    this.locked = nowLocked;
    if (!nowLocked) {
      this.held.clear();
      this.mouseHeld.clear();
      if (wasLocked) this.onPointerLockLost?.();
    }
  };

  private readonly handleBlur = (): void => {
    this.held.clear();
    this.mouseHeld.clear();
  };

  private readonly handleContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  constructor(element: HTMLElement) {
    this.element = element;
  }

  attach(): void {
    if (this.bound) return;
    this.bound = true;
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('mousedown', this.handleMouseDown);
    window.addEventListener('mouseup', this.handleMouseUp);
    window.addEventListener('auxclick', this.handleAuxClick);
    window.addEventListener('mousemove', this.handleMouseMove);
    window.addEventListener('wheel', this.handleWheel, { passive: false });
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('pointerlockchange', this.handleLockChange);
    this.element.addEventListener('contextmenu', this.handleContextMenu);
  }

  detach(): void {
    if (!this.bound) return;
    this.bound = false;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('mousedown', this.handleMouseDown);
    window.removeEventListener('mouseup', this.handleMouseUp);
    window.removeEventListener('auxclick', this.handleAuxClick);
    window.removeEventListener('mousemove', this.handleMouseMove);
    window.removeEventListener('wheel', this.handleWheel);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('pointerlockchange', this.handleLockChange);
    this.element.removeEventListener('contextmenu', this.handleContextMenu);
  }

  requestLock(): void {
    if (this.locked) return;
    const el = this.element as HTMLElement & { requestPointerLock?: () => Promise<void> | void };
    try {
      const result = el.requestPointerLock?.();
      if (result && typeof (result as Promise<void>).catch === 'function') {
        (result as Promise<void>).catch(() => { /* browser refused; menu stays open */ });
      }
    } catch {
      /* ignore - the user can click again */
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  /** True when the middle mouse button was *clicked* this frame. */
  middleClicked(): boolean { return this.middleClicks > 0; }

  /** True when the wheel was scrolled this frame. Never an Ultimate input. */
  wheelScrolled(): boolean { return this.wheelEvents > 0; }

  isDown(code: string): boolean { return this.held.has(code); }
  wasPressed(code: string): boolean { return this.pressed.has(code); }
  wasReleased(code: string): boolean { return this.released.has(code); }
  isMouseDown(button: number): boolean { return this.mouseHeld.has(button); }
  wasMousePressed(button: number): boolean { return this.mousePressed.has(button); }
  wasMouseReleased(button: number): boolean { return this.mouseReleased.has(button); }

  /** Clear per-frame edges and accumulated deltas. Call at the end of a frame. */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed.clear();
    this.mouseReleased.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheelDelta = 0;
    this.middleClicks = 0;
    this.wheelEvents = 0;
  }

  /** Drop all held state (used when the game pauses). */
  clearHeld(): void {
    this.held.clear();
    this.mouseHeld.clear();
  }
}
