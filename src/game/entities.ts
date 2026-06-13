import { playerConfig, racketConfig, shuttleConfig, worldConfig } from './config';
import { clamp, sideDirection } from './math';
import type {
  AiMemory,
  ShuttleFlightProfile,
  ShuttleState,
  Side,
  SwingType,
  Vec2,
} from './types';

export class Player {
  readonly side: Side;
  x: number;
  y = worldConfig.groundY;
  vx = 0;
  vy = 0;
  facing: number;
  grounded = true;
  coyoteTimer = 0;
  jumpBufferTimer = 0;
  swingType: SwingType | null = null;
  swingTimer = 0;
  swingHasHit = false;
  hitIntentJump = false;
  hitIntentMove = 0;
  hitIntentTimer = 0;
  queuedHitTimer = 0;
  queuedHitJump = false;
  queuedHitMove = 0;
  inputFeedbackTimer = 0;
  hitHoldCooldown = 0;
  hitHoldConsumed = false;
  hitInputAge = 0;
  readyHitTimer = 0;
  waitingForActiveMetric = false;
  ai: AiMemory;

  constructor(side: Side) {
    this.side = side;
    this.x = side === 'left' ? 320 : 1280;
    this.facing = sideDirection(side);
    this.ai = {
      serveTimer: 0,
      decisionTimer: 0,
      targetX: this.homeX,
    };
  }

  get homeX(): number {
    return this.side === 'left' ? 370 : 1230;
  }

  get minX(): number {
    return this.side === 'left'
      ? worldConfig.sidePadding
      : worldConfig.netX + playerConfig.radius + 14;
  }

  get maxX(): number {
    return this.side === 'left'
      ? worldConfig.netX - playerConfig.radius - 14
      : worldConfig.width - worldConfig.sidePadding;
  }

  get isSwinging(): boolean {
    return this.swingType !== null;
  }

  get swingDuration(): number {
    return racketConfig.windup + racketConfig.active + racketConfig.recovery;
  }

  get swingPhase(): 'idle' | 'windup' | 'active' | 'recovery' {
    if (!this.swingType) {
      return 'idle';
    }

    const windup = racketConfig.windup;
    const active = racketConfig.active;

    if (this.swingTimer < windup) {
      return 'windup';
    }

    if (this.swingTimer < windup + active) {
      return 'active';
    }

    return 'recovery';
  }

  get activeProgress(): number {
    if (!this.swingType) {
      return 0;
    }

    const windup = racketConfig.windup;
    const active = racketConfig.active;

    return clamp((this.swingTimer - windup) / active, 0, 1);
  }

  get swingProgress(): number {
    if (!this.swingType) {
      return 0;
    }

    return clamp(this.swingTimer / this.swingDuration, 0, 1);
  }

  get recoveryProgress(): number {
    if (this.swingPhase !== 'recovery') {
      return 0;
    }

    return clamp(
      (this.swingTimer - racketConfig.windup - racketConfig.active) /
        racketConfig.recovery,
      0,
      1,
    );
  }

  get canCancelRecovery(): boolean {
    return (
      this.swingPhase === 'recovery' &&
      this.recoveryProgress >= racketConfig.recoveryCancel
    );
  }

  startSwing(force = false): void {
    if (this.isSwinging && !force) {
      return;
    }

    this.swingType = 'hit';
    this.swingTimer = racketConfig.windup === 0 ? 0.0001 : 0;
    this.swingHasHit = false;
  }

  updateSwing(dt: number): void {
    if (!this.swingType) {
      return;
    }

    this.swingTimer += dt;

    if (this.swingTimer >= this.swingDuration) {
      this.swingType = null;
      this.swingTimer = 0;
      this.swingHasHit = false;
    }
  }

  getRacketLine(): { start: Vec2; end: Vec2 } {
    const hand = this.getHandPosition();
    const angle = this.getRacketAngle(this.swingTimer);

    return this.getRacketLineFrom(hand, angle);
  }

  getRacketLineAtSwingTimer(swingTimer: number): { start: Vec2; end: Vec2 } {
    const hand = this.getHandPosition();
    const angle = this.getRacketAngle(swingTimer);

    return this.getRacketLineFrom(hand, angle);
  }

  private getRacketLineFrom(hand: Vec2, angle: number): { start: Vec2; end: Vec2 } {
    return {
      start: hand,
      end: {
        x: hand.x + Math.cos(angle) * racketConfig.length,
        y: hand.y + Math.sin(angle) * racketConfig.length,
      },
    };
  }

  getHandPosition(): Vec2 {
    return {
      x: this.x + this.facing * 31,
      y: this.y - 116,
    };
  }

  private getRacketAngle(swingTimer: number): number {
    const direction = this.facing;

    if (!this.swingType) {
      return direction === 1 ? -0.92 : Math.PI + 0.92;
    }

    const rawProgress = clamp(swingTimer / this.swingDuration, 0, 1);
    const progress = 1 - (1 - rawProgress) ** 2.35;

    const start = direction === 1 ? -1.95 : -1.19;
    const end = direction === 1 ? 0.42 : Math.PI - 0.42;
    return start + (end - start) * progress;
  }
}

export class Shuttlecock {
  x = 0;
  y = 0;
  previousX = 0;
  previousY = 0;
  vx = 0;
  vy = 0;
  state: ShuttleState = 'attached';
  lastTouchedBy: Side = 'left';
  attachedTo: Side = 'left';
  netCooldown = 0;
  dragGraceTimer = 0;
  flightTimer = 0;
  flightProfile: ShuttleFlightProfile = 'rally-arc';

  get position(): Vec2 {
    return { x: this.x, y: this.y };
  }

  get previousPosition(): Vec2 {
    return { x: this.previousX, y: this.previousY };
  }

  attachTo(player: Player): void {
    this.state = 'attached';
    this.attachedTo = player.side;
    this.lastTouchedBy = player.side;
    this.x = player.x + sideDirection(player.side) * 74;
    this.y = player.y - 124;
    this.previousX = this.x;
    this.previousY = this.y;
    this.vx = 0;
    this.vy = 0;
    this.dragGraceTimer = 0;
    this.flightTimer = 0;
    this.flightProfile = 'rally-arc';
  }

  updateAttached(player: Player): void {
    this.x = player.x + sideDirection(player.side) * 74;
    this.y = player.y - 124 + Math.sin(performance.now() / 210) * 2;
    this.previousX = this.x;
    this.previousY = this.y;
  }

  clampSpeed(): void {
    const speed = Math.hypot(this.vx, this.vy);

    if (speed <= shuttleConfig.maxSpeed) {
      return;
    }

    const scale = shuttleConfig.maxSpeed / speed;
    this.vx *= scale;
    this.vy *= scale;
  }
}
