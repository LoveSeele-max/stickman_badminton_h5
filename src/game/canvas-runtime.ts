import { worldConfig } from './config';
import type { InputSystem } from './input-system';
import type { InputSnapshot, Viewport } from './types';

interface RuntimeGame {
  setInput(snapshot: InputSnapshot): void;
  update(dt: number): void;
  render(ctx: CanvasRenderingContext2D, viewport: Viewport): void;
}

export class CanvasRuntime {
  private readonly ctx: CanvasRenderingContext2D;
  private animationId = 0;
  private lastTime = 0;
  private accumulator = 0;
  private readonly fixedStep = 1 / 120;
  private readonly maxFrameTime = 0.12;
  private readonly maxSteps = 12;
  private dpr = 1;
  private cssWidth = 0;
  private cssHeight = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly game: RuntimeGame,
  ) {
    const ctx = canvas.getContext('2d', { alpha: false });

    if (!ctx) {
      throw new Error('Canvas 2D context is not available.');
    }

    this.ctx = ctx;
    window.addEventListener('resize', this.resize);
    this.resize();
  }

  start(input?: InputSystem): void {
    const frame = (time: number): void => {
      this.animationId = window.requestAnimationFrame(frame);
      this.tick(time, input);
    };

    this.animationId = window.requestAnimationFrame(frame);
  }

  stop(): void {
    window.cancelAnimationFrame(this.animationId);
  }

  private tick(timeMs: number, input?: InputSystem): void {
    this.resize();

    const time = timeMs / 1000;
    const dt =
      this.lastTime === 0
        ? this.fixedStep
        : Math.min(time - this.lastTime, this.maxFrameTime);
    this.lastTime = time;
    this.accumulator += dt;

    if (input) {
      this.game.setInput(input.readSnapshot());
    }

    let steps = 0;

    while (this.accumulator >= this.fixedStep && steps < this.maxSteps) {
      this.game.update(this.fixedStep);
      this.accumulator -= this.fixedStep;
      steps += 1;
    }

    if (steps === this.maxSteps) {
      this.accumulator = 0;
    }

    this.render();

    if (input) {
      input.endFrame();
    }
  }

  private readonly resize = (): void => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (
      width === this.cssWidth &&
      height === this.cssHeight &&
      dpr === this.dpr
    ) {
      return;
    }

    this.cssWidth = width;
    this.cssHeight = height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.floor(width * dpr));
    this.canvas.height = Math.max(1, Math.floor(height * dpr));
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
  };

  private render(): void {
    const viewport = this.getViewport();
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    this.game.render(this.ctx, viewport);
  }

  private getViewport(): Viewport {
    const scale = Math.min(
      this.cssWidth / worldConfig.width,
      this.cssHeight / worldConfig.height,
    );

    return {
      width: this.cssWidth,
      height: this.cssHeight,
      scale,
      offsetX: (this.cssWidth - worldConfig.width * scale) / 2,
      offsetY: (this.cssHeight - worldConfig.height * scale) / 2,
      dpr: this.dpr,
    };
  }
}
