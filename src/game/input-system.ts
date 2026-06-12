import type { InputSnapshot } from './types';

const gameKeys = new Set([
  'KeyA',
  'KeyD',
  'KeyS',
  'KeyW',
  'KeyF',
  'KeyG',
  'KeyK',
  'KeyL',
  'ArrowLeft',
  'ArrowRight',
  'ArrowDown',
  'ArrowUp',
  'Digit1',
  'Digit2',
  'Enter',
  'Escape',
  'KeyP',
  'KeyR',
  'KeyM',
  'KeyH',
  'Backquote',
  'Space',
]);

export class InputSystem {
  private readonly down = new Set<string>();
  private readonly pressed = new Set<string>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.canvas.tabIndex = 0;
    this.canvas.addEventListener('pointerdown', () => this.canvas.focus());
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    this.canvas.focus();
  }

  readSnapshot(): InputSnapshot {
    return {
      down: new Set(this.down),
      pressed: new Set(this.pressed),
    };
  }

  endFrame(): void {
    this.pressed.clear();
  }

  private readonly handleKeyDown = (event: KeyboardEvent): void => {
    if (gameKeys.has(event.code)) {
      event.preventDefault();
    }

    if (!this.down.has(event.code)) {
      this.pressed.add(event.code);
    }

    this.down.add(event.code);
  };

  private readonly handleKeyUp = (event: KeyboardEvent): void => {
    if (gameKeys.has(event.code)) {
      event.preventDefault();
    }

    this.down.delete(event.code);
  };
}
