import { createAiIntent } from './ai-controller';
import {
  matchConfig,
  playerConfig,
  racketConfig,
  shuttleConfig,
  worldConfig,
} from './config';
import {
  getFlightDragGrace,
  stepFlightState,
  type FlightState,
} from './flight';
import { Player, Shuttlecock } from './entities';
import {
  clamp,
  lerp,
  projectPointToSegment,
  rectangleContainsCircle,
  sideDirection,
} from './math';
import type {
  AiDifficulty,
  GamePhase,
  InputSnapshot,
  MatchMode,
  PlayerIntent,
  ShotKind,
  ShuttleFlightProfile,
  Side,
  Vec2,
  Viewport,
} from './types';

type FaceZone = 'handle' | 'center' | 'sweet' | 'tip' | 'edge';
type ServeFallbackReason = 'none' | 'invalid' | 'net' | 'receiver' | 'out';
type ServeMode = 'impulse' | 'fallback';
type ShotClampMode = 'standard' | 'drive' | 'smash';

interface HitContact {
  arcScale: number;
  distanceScale: number;
  label: string;
  point: { x: number; y: number };
  powerScale: number;
  t: number;
  zone: FaceZone;
}

interface HitIntentLock {
  jump: boolean;
  move: number;
}

interface ServePrediction {
  flightTime: number;
  landingX: number;
  netClearance: number;
  valid: boolean;
}

interface FlightLandingPrediction {
  flightTime: number;
  landingX: number;
}

interface DebugMetrics {
  flightLandingTime: number;
  flightLandingX: number;
  flightNetTime: number;
  inputToActive: number;
  landingError: number;
  launchAngle: number;
  launchSpeed: number;
  netAngle: number;
  netClearance: number;
  predictedLandingX: number;
  quality: number;
  shot: string;
}

const emptySnapshot: InputSnapshot = {
  down: new Set<string>(),
  pressed: new Set<string>(),
};

export class BadmintonGame {
  private readonly consumedPressed = new Set<string>();
  private input = emptySnapshot;
  private phase: GamePhase = 'menu';
  private mode: MatchMode = 'single';
  private readonly players = {
    left: new Player('left'),
    right: new Player('right'),
  };
  private readonly shuttle = new Shuttlecock();
  private aiDifficulty: AiDifficulty = 'normal';
  private score = { left: 0, right: 0 };
  private server: Side = 'left';
  private serveFallbackCount = 0;
  private winner: Side | null = null;
  private pointTimer = 0;
  private rallyHits = 0;
  private debug = false;
  private message = 'Press 1 Normal AI, 2 Boss AI, or 3 Local Versus';
  private lastHitLabel = '';
  private lastHitTimer = 0;
  private impactX = 0;
  private impactY = 0;
  private impactPower = 1;
  private impactTimer = 0;
  private hitStopTimer = 0;
  private trailBoostPower = 0;
  private trailBoostTimer = 0;
  private debugMetrics: DebugMetrics = {
    flightLandingTime: -1,
    flightLandingX: -1,
    flightNetTime: -1,
    inputToActive: 0,
    landingError: 0,
    launchAngle: 0,
    launchSpeed: 0,
    netAngle: 0,
    netClearance: 0,
    predictedLandingX: -1,
    quality: 0,
    shot: '',
  };
  private serveDebug:
    | {
        fallbackReason: ServeFallbackReason;
      fallbackUsed: boolean;
      flightTime: number;
      landingX: number;
      landingError: number;
      mode: ServeMode;
      netClearance: number;
      totalFallbacks: number;
      targetX: number;
      valid: boolean;
      }
    | null = null;

  constructor(initialMode?: MatchMode, initialAiDifficulty: AiDifficulty = 'normal') {
    this.resetMatch('single', initialAiDifficulty);
    if (!initialMode) {
      this.phase = 'menu';
      this.message = 'Press 1 Normal AI, 2 Boss AI, or 3 Local Versus';
    } else if (initialMode !== 'single') {
      this.resetMatch(initialMode);
    }
  }

  setInput(snapshot: InputSnapshot): void {
    this.input = snapshot;
    this.consumedPressed.clear();
  }

  update(dt: number): void {
    if (this.wasPressed('KeyH') || this.wasPressed('Backquote')) {
      this.debug = !this.debug;
    }

    const hitStopActive = this.phase === 'playing' && this.hitStopTimer > 0;
    const simulationDt = hitStopActive ? dt * 0.16 : dt;
    const visualDt = this.phase === 'playing' ? simulationDt : dt;
    this.hitStopTimer = Math.max(0, this.hitStopTimer - dt);
    this.lastHitTimer = Math.max(0, this.lastHitTimer - dt);
    this.impactTimer = Math.max(0, this.impactTimer - visualDt);
    this.trailBoostTimer = Math.max(0, this.trailBoostTimer - visualDt);
    if (this.trailBoostTimer <= 0) {
      this.trailBoostPower = 0;
    }

    switch (this.phase) {
      case 'menu':
        this.updateMenu();
        break;
      case 'playing':
        this.updatePlaying(dt, simulationDt);
        break;
      case 'paused':
        this.updatePaused();
        break;
      case 'point':
        this.updatePoint(dt);
        break;
      case 'matchEnd':
        this.updateMatchEnd();
        break;
    }
  }

  render(ctx: CanvasRenderingContext2D, viewport: Viewport): void {
    this.drawScreenBackground(ctx, viewport);
    ctx.save();
    ctx.translate(viewport.offsetX, viewport.offsetY);
    ctx.scale(viewport.scale, viewport.scale);

    this.drawWorld(ctx);

    if (this.phase === 'menu') {
      this.drawMenu(ctx);
    } else {
      this.drawHud(ctx);
      this.drawPhaseOverlay(ctx);
    }

    if (this.debug) {
      this.drawDebug(ctx);
    }

    ctx.restore();
  }

  private updateMenu(): void {
    if (this.wasPressed('Digit1') || this.wasPressed('Enter')) {
      this.resetMatch('single', 'normal');
      return;
    }

    if (this.wasPressed('Digit2')) {
      this.resetMatch('single', 'boss');
      return;
    }

    if (this.wasPressed('Digit3')) {
      this.resetMatch('versus');
    }
  }

  private updatePlaying(dt: number, simulationDt = dt): void {
    if (this.wasPressed('Escape') || this.wasPressed('KeyP')) {
      this.phase = 'paused';
      this.message = 'Paused';
      return;
    }

    const leftIntent = this.getControllerIntent(this.players.left, dt);
    const rightIntent = this.getControllerIntent(this.players.right, dt);

    this.updatePlayer(this.players.left, leftIntent, dt);
    this.updatePlayer(this.players.right, rightIntent, dt);

    if (this.shuttle.state === 'attached') {
      const serverPlayer = this.players[this.server];
      this.shuttle.updateAttached(serverPlayer);

      if (
        serverPlayer.swingPhase === 'active' &&
        !serverPlayer.swingHasHit
      ) {
        this.launchServe(serverPlayer);
      }

      return;
    }

    this.updateShuttle(simulationDt);
    this.resolveRacketHits(leftIntent, rightIntent, dt);
    this.resolveNetCollision();
    this.resolvePointEnd();
  }

  private updatePaused(): void {
    if (
      this.wasPressed('Escape') ||
      this.wasPressed('KeyP') ||
      this.wasPressed('Enter')
    ) {
      this.phase = 'playing';
      this.message = '';
      return;
    }

    if (this.wasPressed('KeyR')) {
      this.resetMatch(this.mode);
      return;
    }

    if (this.wasPressed('KeyM')) {
      this.phase = 'menu';
      this.message = 'Press 1 Normal AI, 2 Boss AI, or 3 Local Versus';
    }
  }

  private updatePoint(dt: number): void {
    this.pointTimer -= dt;

    if (this.pointTimer <= 0) {
      this.resetRally(this.server);
      this.phase = 'playing';
    }
  }

  private updateMatchEnd(): void {
    if (this.wasPressed('KeyR') || this.wasPressed('Enter')) {
      this.resetMatch(this.mode);
      return;
    }

    if (this.wasPressed('KeyM') || this.wasPressed('Escape')) {
      this.phase = 'menu';
      this.message = 'Press 1 Normal AI, 2 Boss AI, or 3 Local Versus';
    }
  }

  private getControllerIntent(player: Player, dt: number): PlayerIntent {
    if (this.mode === 'single' && player.side === 'right') {
      return createAiIntent(
        player,
        this.players.left,
        this.shuttle,
        dt,
        this.aiDifficulty,
      );
    }

    return this.getHumanIntent(player.side);
  }

  private getHumanIntent(side: Side): PlayerIntent {
    const keys =
      side === 'left'
        ? {
            left: 'KeyA',
            right: 'KeyD',
            up: 'KeyW',
            hit: 'KeyS',
          }
        : {
            left: 'ArrowLeft',
            right: 'ArrowRight',
            up: 'ArrowUp',
            hit: 'ArrowDown',
          };
    const moveWorld =
      (this.isDown(keys.right) ? 1 : 0) - (this.isDown(keys.left) ? 1 : 0);

    return {
      move: moveWorld,
      jump: this.isDown(keys.up),
      jumpPressed: this.wasPressed(keys.up),
      hitHeld: this.isDown(keys.hit),
      hitPressed: this.wasPressed(keys.hit),
      pausePressed: this.wasPressed('Escape') || this.wasPressed('KeyP'),
    };
  }

  private updatePlayer(
    player: Player,
    intent: PlayerIntent,
    dt: number,
  ): void {
    if (intent.pausePressed) {
      this.phase = 'paused';
      return;
    }

    player.facing = sideDirection(player.side);

    if (player.grounded) {
      player.coyoteTimer = playerConfig.coyoteTime;
    } else {
      player.coyoteTimer = Math.max(0, player.coyoteTimer - dt);
    }

    if (intent.jumpPressed) {
      player.jumpBufferTimer = playerConfig.jumpBuffer;
    } else {
      player.jumpBufferTimer = Math.max(0, player.jumpBufferTimer - dt);
    }

    const targetSpeed = intent.move * playerConfig.maxSpeed;
    const speedStep =
      (player.grounded
        ? intent.move === 0
          ? playerConfig.groundDeceleration
          : playerConfig.groundAcceleration
        : playerConfig.airAcceleration) * dt;
    player.vx = approach(player.vx, targetSpeed, speedStep);

    if (player.jumpBufferTimer > 0 && player.coyoteTimer > 0) {
      player.vy = -playerConfig.jumpSpeed;
      player.grounded = false;
      player.jumpBufferTimer = 0;
      player.coyoteTimer = 0;
    }

    player.vy += playerConfig.gravity * dt;
    player.x += player.vx * dt;
    player.y += player.vy * dt;

    if (player.y >= worldConfig.groundY) {
      player.y = worldConfig.groundY;
      player.vy = 0;
      player.grounded = true;
    } else {
      player.grounded = false;
    }

    if (player.x < player.minX || player.x > player.maxX) {
      player.x = clamp(player.x, player.minX, player.maxX);
      player.vx = 0;
    }

    if (intent.hitPressed) {
      this.queueHit(player, intent);
      player.hitHoldConsumed = true;
    } else if (this.shouldQueueHeldHit(player, intent)) {
      this.queueHit(player, intent);
      player.hitHoldCooldown = 0.34;
      player.hitHoldConsumed = true;
    }

    if (!intent.hitHeld) {
      player.hitHoldConsumed = false;
    }

    player.hitIntentTimer = Math.max(0, player.hitIntentTimer - dt);
    player.queuedHitTimer = Math.max(0, player.queuedHitTimer - dt);
    player.inputFeedbackTimer = Math.max(0, player.inputFeedbackTimer - dt);
    player.readyHitTimer = intent.hitHeld && !player.hitHoldConsumed
      ? 0.08
      : Math.max(0, player.readyHitTimer - dt);
    player.hitHoldCooldown = Math.max(0, player.hitHoldCooldown - dt);
    if (player.waitingForActiveMetric) {
      player.hitInputAge += dt;
    }
    const wasSwinging = player.isSwinging;
    const wasActive = player.swingPhase === 'active';
    const swingHadHit = player.swingHasHit;
    player.updateSwing(dt);

    const startedQueuedSwing = this.tryStartQueuedSwing(player);
    const isActive = player.swingPhase === 'active';

    if (player.waitingForActiveMetric && !wasActive && isActive) {
      this.debugMetrics.inputToActive = player.hitInputAge;
      player.waitingForActiveMetric = false;
    }

    if (wasSwinging && !player.isSwinging && !swingHadHit && !startedQueuedSwing) {
      this.showSwingMiss(player);
    }
  }

  private shouldQueueHeldHit(player: Player, intent: PlayerIntent): boolean {
    if (
      !intent.hitHeld ||
      player.hitHoldConsumed ||
      player.isSwinging ||
      player.queuedHitTimer > 0 ||
      player.hitHoldCooldown > 0 ||
      this.shuttle.state !== 'flying'
    ) {
      return false;
    }

    const assist = this.getHitAssist(player);
    const direction = sideDirection(player.side);
    const ballOnOwnSide =
      player.side === 'left'
        ? this.shuttle.x < worldConfig.netX
        : this.shuttle.x > worldConfig.netX;
    const incoming = direction * this.shuttle.vx < 180 || ballOnOwnSide;

    return assist.inZone && incoming;
  }

  private tryStartQueuedSwing(player: Player): boolean {
    if (player.queuedHitTimer <= 0) {
      return false;
    }

    if (!player.isSwinging) {
      this.promoteQueuedHit(player);
      player.startSwing();
      return true;
    }

    if (player.canCancelRecovery) {
      this.promoteQueuedHit(player);
      player.startSwing(true);
      return true;
    }

    return false;
  }

  private getHitQueueDuration(player: Player): number {
    if (!player.isSwinging || player.canCancelRecovery) {
      return racketConfig.hitBuffer;
    }

    const cancelAt =
      racketConfig.windup +
      racketConfig.active +
      racketConfig.recovery * racketConfig.recoveryCancel;

    return Math.max(
      racketConfig.hitBuffer,
      cancelAt - player.swingTimer + racketConfig.hitBuffer,
    );
  }

  private queueHit(player: Player, intent: PlayerIntent): void {
    player.queuedHitMove = intent.move;
    player.queuedHitJump = intent.jump || !player.grounded;
    player.queuedHitTimer = this.getHitQueueDuration(player);
    player.inputFeedbackTimer = 0.14;
    player.hitInputAge = 0;
    player.waitingForActiveMetric = true;
  }

  private promoteQueuedHit(player: Player): void {
    player.hitIntentMove = player.queuedHitMove;
    player.hitIntentJump = player.queuedHitJump;
    player.hitIntentTimer = player.swingDuration + 0.04;
    player.queuedHitTimer = 0;
  }

  private launchServe(player: Player): void {
    const direction = sideDirection(player.side);
    const start = this.getServeLaunchPosition(player);
    const targetX = direction === 1 ? 1210 : 390;
    const dragGraceTimer = getFlightDragGrace('serve') + 0.1;
    const serve = this.getServeImpulseVelocity(
      start,
      direction,
      targetX,
      dragGraceTimer,
    );

    player.swingHasHit = true;
    this.shuttle.state = 'flying';
    this.shuttle.lastTouchedBy = player.side;
    this.shuttle.attachedTo = player.side;
    this.shuttle.x = start.x;
    this.shuttle.y = start.y;
    this.shuttle.previousX = this.shuttle.x;
    this.shuttle.previousY = this.shuttle.y;
    this.shuttle.vx = serve.velocity.x;
    this.shuttle.vy = serve.velocity.y;
    this.shuttle.dragGraceTimer = dragGraceTimer;
    this.shuttle.flightTimer = 0;
    this.shuttle.flightProfile = 'serve';
    if (serve.fallbackUsed) {
      this.serveFallbackCount += 1;
    }
    this.serveDebug = {
      fallbackReason: serve.fallbackReason,
      fallbackUsed: serve.fallbackUsed,
      flightTime: serve.prediction.flightTime,
      landingX: serve.prediction.landingX,
      landingError: serve.prediction.landingX - targetX,
      mode: serve.mode,
      netClearance: serve.prediction.netClearance,
      totalFallbacks: this.serveFallbackCount,
      targetX,
      valid: serve.prediction.valid,
    };
    this.startFlightDebug(
      'serve-start',
      1,
      { x: this.shuttle.vx, y: this.shuttle.vy },
      serve.prediction.landingX,
    );
    this.lastHitLabel = 'Power Serve';
    this.lastHitTimer = 0.72;
    this.impactX = start.x;
    this.impactY = start.y;
    this.impactPower = 1.42;
    this.impactTimer = 0.24;
    this.triggerHitPunch(1.36, 0.052, 0.3);
    this.rallyHits = 0;
    this.message = '';
  }

  private getServeLaunchPosition(player: Player): Vec2 {
    const direction = sideDirection(player.side);
    const carried = {
      x: player.x + direction * 90,
      y: player.y - 136,
    };
    const racket = player.getRacketLine();
    const racketPoint = pointOnSegment(racket, 0.68);

    return {
      x: lerp(carried.x, racketPoint.x, 0.48),
      y: clamp(lerp(carried.y, racketPoint.y, 0.48), player.y - 214, player.y - 126),
    };
  }

  private getServeImpulseVelocity(
    start: Vec2,
    direction: number,
    targetX: number,
    dragGraceTimer: number,
  ): {
    fallbackReason: ServeFallbackReason;
    fallbackUsed: boolean;
    mode: ServeMode;
    velocity: Vec2;
    prediction: ServePrediction;
  } {
    const baseSpeed = 1280;
    const baseAngle = -0.74;
    let fallbackReason: ServeFallbackReason = 'none';
    let fallbackUsed = false;
    let velocity = {
      x: direction * Math.cos(baseAngle) * baseSpeed,
      y: Math.sin(baseAngle) * baseSpeed,
    };

    for (let i = 0; i < 3; i += 1) {
      const prediction = this.predictServe(start, velocity, dragGraceTimer);
      const targetError = targetX - prediction.landingX;
      const clearanceError = 84 - prediction.netClearance;
      const timeLift =
        prediction.flightTime < 1.08
          ? (1.08 - prediction.flightTime) * 120
          : prediction.flightTime > 1.55
            ? (1.55 - prediction.flightTime) * 80
            : 0;
      const iterationScale = i === 0 ? 1 : 0.58;

      velocity = {
        x:
          velocity.x +
          clamp(targetError / Math.max(prediction.flightTime, 0.8), -260, 260) *
            0.42 *
            iterationScale,
        y:
          velocity.y -
          clamp(clearanceError * 2.1 + timeLift, -130, 180) *
            0.58 *
            iterationScale,
      };
      velocity = this.finalizeShotVelocity(velocity, direction, 760, 1080, 1520);
    }

    let prediction = this.predictServe(start, velocity, dragGraceTimer);
    fallbackReason = this.getServeFallbackReason(prediction, direction);

    if (fallbackReason !== 'none') {
      const fallback = this.solveServeVelocity(start, direction, targetX, dragGraceTimer);
      velocity = fallback.velocity;
      prediction = fallback.prediction;
      fallbackUsed = true;
    }

    return {
      fallbackReason,
      fallbackUsed,
      mode: fallbackUsed ? 'fallback' : 'impulse',
      velocity,
      prediction,
    };
  }

  private getServeFallbackReason(
    prediction: ServePrediction,
    direction: number,
  ): ServeFallbackReason {
    const crossedToReceiver =
      direction === 1
        ? prediction.landingX > worldConfig.netX + 120
        : prediction.landingX < worldConfig.netX - 120;
    const landsInWorld =
      prediction.landingX > worldConfig.sidePadding &&
      prediction.landingX < worldConfig.width - worldConfig.sidePadding;

    if (prediction.netClearance > -900 && prediction.netClearance < 62) {
      return 'net';
    }

    if (!crossedToReceiver) {
      return 'receiver';
    }

    if (!landsInWorld) {
      return 'out';
    }

    if (!prediction.valid) {
      return 'invalid';
    }

    return 'none';
  }

  private solveServeVelocity(
    start: Vec2,
    direction: number,
    targetX: number,
    dragGraceTimer: number,
  ): { velocity: Vec2; prediction: ServePrediction } {
    const candidates = [
      { speed: 1040, angle: -0.9 },
      { speed: 1120, angle: -0.84 },
      { speed: 1200, angle: -0.78 },
      { speed: 1280, angle: -0.72 },
      { speed: 1360, angle: -0.66 },
    ];
    let best = {
      prediction: this.predictServe(
        start,
        { x: direction * 1180, y: -850 },
        dragGraceTimer,
      ),
      score: Number.POSITIVE_INFINITY,
      velocity: { x: direction * 1180, y: -850 },
    };

    for (const candidate of candidates) {
      for (let speedStep = -3; speedStep <= 3; speedStep += 1) {
        for (let angleStep = -3; angleStep <= 3; angleStep += 1) {
          const speed = candidate.speed + speedStep * 34;
          const angle = candidate.angle + angleStep * 0.035;
          const velocity = {
            x: direction * Math.cos(angle) * speed,
            y: Math.sin(angle) * speed,
          };
          const prediction = this.predictServe(start, velocity, dragGraceTimer);
          const targetError = Math.abs(prediction.landingX - targetX);
          const clearanceError =
            prediction.netClearance < 62
              ? (62 - prediction.netClearance) * 7
              : Math.max(0, prediction.netClearance - 180) * 0.8;
          const timeError =
            prediction.flightTime < 1.08
              ? (1.08 - prediction.flightTime) * 180
              : prediction.flightTime > 1.55
                ? (prediction.flightTime - 1.55) * 160
                : 0;
          const sidePenalty =
            direction === 1
              ? prediction.landingX < worldConfig.netX + 260
                ? 800
                : 0
              : prediction.landingX > worldConfig.netX - 260
                ? 800
                : 0;
          const score =
            targetError + clearanceError + timeError + sidePenalty + (prediction.valid ? 0 : 1000);

          if (score < best.score) {
            best = { prediction, score, velocity };
          }
        }
      }
    }

    return best;
  }

  private predictServe(
    start: Vec2,
    velocity: Vec2,
    dragGraceTimer = getFlightDragGrace('serve'),
  ): ServePrediction {
    const step = 1 / 120;
    const netTop = worldConfig.groundY - worldConfig.netHeight;
    let state: FlightState = {
      dragGraceTimer,
      flightProfile: 'serve',
      flightTimer: 0,
      vx: velocity.x,
      vy: velocity.y,
      x: start.x,
      y: start.y,
    };
    let netClearance = -999;
    let crossedNet = false;

    for (let i = 0; i < 260; i += 1) {
      const previous = { x: state.x, y: state.y };
      state = stepFlightState(state, step);

      if (
        !crossedNet &&
        (previous.x - worldConfig.netX) * (state.x - worldConfig.netX) <= 0
      ) {
        const dx = state.x - previous.x;
        const t = clamp(
          Math.abs(dx) < 0.001 ? 0 : (worldConfig.netX - previous.x) / dx,
          0,
          1,
        );
        const netY = lerp(previous.y, state.y, t);
        netClearance = netTop - netY;
        crossedNet = true;
      }

      if (state.y + shuttleConfig.radius >= worldConfig.groundY) {
        return {
          flightTime: state.flightTimer,
          landingX: state.x,
          netClearance,
          valid: crossedNet && netClearance > 48,
        };
      }
    }

    return {
      flightTime: state.flightTimer,
      landingX: state.x,
      netClearance,
      valid: false,
    };
  }

  private updateShuttle(dt: number): void {
    if (this.shuttle.state !== 'flying') {
      return;
    }

    this.shuttle.previousX = this.shuttle.x;
    this.shuttle.previousY = this.shuttle.y;
    const previous = {
      flightTimer: this.shuttle.flightTimer,
      vx: this.shuttle.vx,
      vy: this.shuttle.vy,
      x: this.shuttle.x,
      y: this.shuttle.y,
    };

    const next = stepFlightState(
      {
        dragGraceTimer: this.shuttle.dragGraceTimer,
        flightProfile: this.shuttle.flightProfile,
        flightTimer: this.shuttle.flightTimer,
        vx: this.shuttle.vx,
        vy: this.shuttle.vy,
        x: this.shuttle.x,
        y: this.shuttle.y,
      },
      dt,
    );
    this.shuttle.x = next.x;
    this.shuttle.y = next.y;
    this.shuttle.vx = next.vx;
    this.shuttle.vy = next.vy;
    this.shuttle.dragGraceTimer = next.dragGraceTimer;
    this.shuttle.flightTimer = next.flightTimer;
    this.shuttle.clampSpeed();
    this.shuttle.netCooldown = Math.max(0, this.shuttle.netCooldown - dt);
    this.updateFlightDebug(previous);
  }

  private startFlightDebug(
    shot: string,
    quality: number,
    velocity: Vec2,
    predictedLandingX: number,
  ): void {
    this.debugMetrics.flightLandingTime = -1;
    this.debugMetrics.flightLandingX = -1;
    this.debugMetrics.flightNetTime = -1;
    this.debugMetrics.landingError = 0;
    this.debugMetrics.launchAngle = velocityAngleDegrees(velocity);
    this.debugMetrics.launchSpeed = Math.hypot(velocity.x, velocity.y);
    this.debugMetrics.netAngle = 0;
    this.debugMetrics.netClearance = 0;
    this.debugMetrics.predictedLandingX = predictedLandingX;
    this.debugMetrics.quality = quality;
    this.debugMetrics.shot = shot;
  }

  private updateFlightDebug(
    previous: { flightTimer: number; vx: number; vy: number; x: number; y: number },
  ): void {
    if (
      this.debugMetrics.flightNetTime >= 0 ||
      (previous.x - worldConfig.netX) * (this.shuttle.x - worldConfig.netX) > 0
    ) {
      return;
    }

    const dx = this.shuttle.x - previous.x;
    const t = clamp(
      Math.abs(dx) < 0.001 ? 0 : (worldConfig.netX - previous.x) / dx,
      0,
      1,
    );
    const netY = lerp(previous.y, this.shuttle.y, t);
    const netVx = lerp(previous.vx, this.shuttle.vx, t);
    const netVy = lerp(previous.vy, this.shuttle.vy, t);
    this.debugMetrics.flightNetTime = lerp(previous.flightTimer, this.shuttle.flightTimer, t);
    this.debugMetrics.netClearance = worldConfig.groundY - worldConfig.netHeight - netY;
    this.debugMetrics.netAngle = velocityAngleDegrees({ x: netVx, y: netVy });
  }

  private resolveRacketHits(
    leftIntent: PlayerIntent,
    rightIntent: PlayerIntent,
    dt: number,
  ): void {
    if (this.shuttle.state !== 'flying') {
      return;
    }

    this.tryHitWithPlayer(this.players.left, leftIntent, dt);
    this.tryHitWithPlayer(this.players.right, rightIntent, dt);
  }

  private tryHitWithPlayer(player: Player, intent: PlayerIntent, dt: number): void {
    if (
      player.swingPhase !== 'active' ||
      player.swingHasHit ||
      sideDirection(player.side) * (this.shuttle.x - player.x) < -20
    ) {
      return;
    }

    const racket = player.getRacketLine();
    const currentProjection = projectPointToSegment(
      this.shuttle.position,
      racket.start,
      racket.end,
    );
    const previousRacket = player.getRacketLineAtSwingTimer(
      Math.max(racketConfig.windup, player.swingTimer - dt),
    );
    const previousShuttle = this.shuttle.previousPosition;
    const middleShuttle = midpoint(previousShuttle, this.shuttle.position);
    const middleRacket = {
      start: midpoint(previousRacket.start, racket.start),
      end: midpoint(previousRacket.end, racket.end),
    };
    const previousProjection = projectPointToSegment(
      previousShuttle,
      previousRacket.start,
      previousRacket.end,
    );
    const middleProjection = projectPointToSegment(
      middleShuttle,
      middleRacket.start,
      middleRacket.end,
    );
    const threshold = racketConfig.hitRadius + shuttleConfig.radius;
    const sweepThreshold = threshold * 0.86;
    const sweetSweep = projectPointToSegment(
      this.shuttle.position,
      pointOnSegment(previousRacket, 0.74),
      pointOnSegment(racket, 0.74),
    );
    const tipSweep = projectPointToSegment(
      this.shuttle.position,
      pointOnSegment(previousRacket, 0.92),
      pointOnSegment(racket, 0.92),
    );
    const candidates = [
      { projection: currentProjection, distance: currentProjection.distance, threshold },
      { projection: previousProjection, distance: previousProjection.distance, threshold },
      { projection: middleProjection, distance: middleProjection.distance, threshold },
      {
        projection: { ...sweetSweep, t: 0.74 },
        distance: sweetSweep.distance,
        threshold: sweepThreshold,
      },
      {
        projection: { ...tipSweep, t: 0.92 },
        distance: tipSweep.distance,
        threshold: sweepThreshold * 0.95,
      },
    ];
    const best = candidates.reduce((closest, candidate) =>
      candidate.distance / candidate.threshold < closest.distance / closest.threshold
        ? candidate
        : closest,
    );
    const hitDistance = best.distance;
    const assist = this.getHitAssist(player);

    if (hitDistance > best.threshold && !assist.inZone) {
      return;
    }

    const contact = this.getHitContact(best.projection, best.threshold, assist);
    const timing = 1 - Math.abs(player.activeProgress - 0.5) * 2;
    const center = assist.inZone
      ? Math.max(1 - clamp(hitDistance / best.threshold, 0, 1), assist.zoneQuality)
      : 1 - clamp(hitDistance / best.threshold, 0, 1);
    const faceSweetness = 1 - clamp(Math.abs(contact.t - 0.74) / 0.42, 0, 1);
    const quality = clamp(
      0.42 + center * 0.3 + timing * 0.2 + faceSweetness * 0.14,
      0,
      1,
    );
    const lockedIntent = this.getHitIntent(player, intent);
    const shot = this.chooseShot(player, contact, lockedIntent);
    const racketVelocity = this.getRacketContactVelocity(
      previousRacket,
      racket,
      contact.t,
      dt,
    );
    const incomingVelocity = { x: this.shuttle.vx, y: this.shuttle.vy };
    const flightProfile = this.getShotFlightProfile(shot);
    const launchPosition = this.getHitLaunchPosition(player, contact);
    const dragGraceTimer = this.getShotDragGrace(flightProfile, shot, contact);
    const velocity = this.getShotVelocity(
      player,
      shot,
      quality,
      contact,
      lockedIntent,
      racketVelocity,
      incomingVelocity,
      launchPosition,
      flightProfile,
      dragGraceTimer,
    );
    const predictedLandingX = this.debug
      ? this.predictFlightLanding(
          launchPosition,
          velocity,
          flightProfile,
          dragGraceTimer,
        ).landingX
      : -1;

    player.swingHasHit = true;
    player.hitIntentTimer = 0;
    this.shuttle.lastTouchedBy = player.side;
    this.shuttle.vx = velocity.x;
    this.shuttle.vy = velocity.y;
    this.shuttle.dragGraceTimer = dragGraceTimer;
    this.shuttle.flightTimer = 0;
    this.shuttle.flightProfile = flightProfile;
    this.shuttle.x = launchPosition.x;
    this.shuttle.y = launchPosition.y;
    this.shuttle.previousX = this.shuttle.x;
    this.shuttle.previousY = this.shuttle.y;
    this.rallyHits += 1;
    this.startFlightDebug(shot, quality, velocity, predictedLandingX);
    this.lastHitLabel = `${contact.label} ${shot}`;
    this.lastHitTimer = 0.72;
    this.impactX = this.shuttle.x;
    this.impactY = this.shuttle.y;
    this.impactPower = this.getHitPunchPower(shot, contact);
    this.impactTimer = shot === 'smash' || contact.zone === 'sweet' ? 0.24 : 0.18;
    this.triggerHitPunch(
      this.impactPower,
      shot === 'smash' || contact.zone === 'sweet' ? 0.052 : 0.034,
      shot === 'smash' || shot === 'drive' ? 0.24 : 0.18,
    );
  }

  private getHitContact(
    projection: { distance: number; point: { x: number; y: number }; t: number },
    threshold: number,
    assist: { inZone: boolean; zoneQuality: number },
  ): HitContact {
    const edgeAmount = 1 - clamp(projection.distance / threshold, 0, 1);
    let zone: FaceZone;

    if (edgeAmount < 0.22 && (!assist.inZone || assist.zoneQuality < 0.34)) {
      zone = 'edge';
    } else if (projection.t < 0.46) {
      zone = 'handle';
    } else if (projection.t < 0.66) {
      zone = 'center';
    } else if (projection.t < 0.88) {
      zone = 'sweet';
    } else {
      zone = 'tip';
    }

    const tuning = {
      handle: { arcScale: 1.1, distanceScale: 0.86, label: 'Handle', powerScale: 0.82 },
      center: { arcScale: 1, distanceScale: 1.04, label: 'Center', powerScale: 1.12 },
      sweet: { arcScale: 0.9, distanceScale: 1.16, label: 'Sweet', powerScale: 1.34 },
      tip: { arcScale: 0.88, distanceScale: 1.12, label: 'Tip', powerScale: 1.2 },
      edge: { arcScale: 1.14, distanceScale: 0.78, label: 'Edge', powerScale: 0.72 },
    } satisfies Record<
      FaceZone,
      { arcScale: number; distanceScale: number; label: string; powerScale: number }
    >;
    const selected = tuning[zone];
    const assistBoost = assist.inZone ? lerp(0.96, 1.02, assist.zoneQuality) : 1;

    return {
      ...selected,
      distanceScale: selected.distanceScale * assistBoost,
      point: projection.point,
      t: projection.t,
      zone,
    };
  }

  private showSwingMiss(player: Player): void {
    const direction = sideDirection(player.side);
    const hand = player.getHandPosition();
    const reason = this.getMissReason(player);
    this.lastHitLabel = reason ? `Miss ${reason}` : 'Miss';
    this.lastHitTimer = 0.38;
    this.impactX = hand.x + direction * 78;
    this.impactY = hand.y - 12;
    this.impactPower = 0.54;
    this.impactTimer = 0.08;
  }

  private triggerHitPunch(power: number, hitStop: number, trailTime: number): void {
    if (power < 0.98) {
      return;
    }

    this.hitStopTimer = Math.max(this.hitStopTimer, hitStop * clamp(power, 0.9, 1.55));
    this.trailBoostTimer = Math.max(this.trailBoostTimer, trailTime);
    this.trailBoostPower = Math.max(this.trailBoostPower, power);
  }

  private getMissReason(player: Player): string {
    if (this.shuttle.state !== 'flying') {
      return '';
    }

    const direction = sideDirection(player.side);
    const forward = direction * (this.shuttle.x - player.x);
    const height = player.y - this.shuttle.y;

    if (height < racketConfig.assistHeightMin) {
      return 'Low';
    }

    if (height > racketConfig.assistHeightMax) {
      return 'High';
    }

    if (forward < racketConfig.assistForwardMin) {
      return 'Behind';
    }

    if (forward > racketConfig.assistForwardMax) {
      return 'Far';
    }

    return 'Timing';
  }

  private getHitIntent(
    player: Player,
    fallback: PlayerIntent,
  ): HitIntentLock {
    if (player.hitIntentTimer > 0) {
      return {
        jump: player.hitIntentJump,
        move: player.hitIntentMove,
      };
    }

    return {
      jump: fallback.jump || !player.grounded,
      move: fallback.move,
    };
  }

  private getHitAssist(player: Player): { inZone: boolean; zoneQuality: number } {
    const direction = sideDirection(player.side);
    const forward = direction * (this.shuttle.x - player.x);
    const height = player.y - this.shuttle.y;
    const xRange = racketConfig.assistForwardMax - racketConfig.assistForwardMin;
    const yRange = racketConfig.assistHeightMax - racketConfig.assistHeightMin;
    const xMid = (racketConfig.assistForwardMax + racketConfig.assistForwardMin) / 2;
    const yMid = (racketConfig.assistHeightMax + racketConfig.assistHeightMin) / 2;
    const normalizedX = Math.abs(forward - xMid) / (xRange / 2);
    const normalizedY = Math.abs(height - yMid) / (yRange / 2);
    const inZone =
      forward >= racketConfig.assistForwardMin &&
      forward <= racketConfig.assistForwardMax &&
      height >= racketConfig.assistHeightMin &&
      height <= racketConfig.assistHeightMax;

    return {
      inZone,
      zoneQuality: clamp(1 - Math.max(normalizedX, normalizedY) * 0.72, 0.18, 1),
    };
  }

  private chooseShot(
    player: Player,
    contact: HitContact,
    intent: HitIntentLock,
  ): ShotKind {
    const heightAboveGround = worldConfig.groundY - this.shuttle.y;
    const direction = sideDirection(player.side);
    const forwardInput = direction * intent.move;

    if (
      (intent.jump || !player.grounded) &&
      heightAboveGround > 220 &&
      contact.zone !== 'handle'
    ) {
      return 'smash';
    }

    if (forwardInput > 0 && contact.zone !== 'handle') {
      return 'drive';
    }

    if (forwardInput < 0 || heightAboveGround < 150 || contact.zone === 'handle') {
      return 'lift';
    }

    if (heightAboveGround > 320 && contact.zone !== 'tip') {
      return 'clear';
    }

    return 'neutral';
  }

  private getShotFlightProfile(shot: ShotKind): ShuttleFlightProfile {
    return shot === 'drive' || shot === 'smash' ? 'rally-fast' : 'rally-arc';
  }

  private getHitLaunchPosition(player: Player, contact: HitContact): Vec2 {
    return {
      x: contact.point.x + sideDirection(player.side) * 18,
      y: clamp(
        contact.point.y,
        player.y - racketConfig.assistHeightMax,
        player.y - racketConfig.assistHeightMin,
      ),
    };
  }

  private getShotDragGrace(
    flightProfile: ShuttleFlightProfile,
    shot: ShotKind,
    contact: HitContact,
  ): number {
    const baseGrace = getFlightDragGrace(flightProfile);

    if (contact.zone === 'edge' || contact.zone === 'handle') {
      return baseGrace;
    }

    if (shot === 'smash') {
      return baseGrace + 0.12;
    }

    if (shot === 'drive') {
      return baseGrace + (contact.zone === 'sweet' ? 0.1 : 0.07);
    }

    return baseGrace + (contact.zone === 'sweet' ? 0.06 : 0.035);
  }

  private getHitPunchPower(shot: ShotKind, contact: HitContact): number {
    const shotBoost =
      shot === 'smash'
        ? 0.28
        : shot === 'drive'
          ? 0.16
          : shot === 'clear'
            ? 0.08
            : 0;
    const faceBoost =
      contact.zone === 'sweet'
        ? 0.22
        : contact.zone === 'center' || contact.zone === 'tip'
          ? 0.1
          : contact.zone === 'edge'
            ? -0.16
            : -0.08;

    return clamp(contact.powerScale + shotBoost + faceBoost, 0.72, 1.58);
  }

  private getShotVelocity(
    player: Player,
    shot: ShotKind,
    quality: number,
    contact: HitContact,
    intent: HitIntentLock,
    racketVelocity: Vec2,
    incomingVelocity: Vec2,
    launchPosition: Vec2,
    flightProfile: ShuttleFlightProfile,
    dragGraceTimer: number,
  ): Vec2 {
    const direction = sideDirection(player.side);
    const forwardInput = direction * intent.move;
    const opponent = this.players[oppositeSide(player.side)];
    const nearNet = worldConfig.netX + direction * 155;
    const deepCourt = direction === 1 ? worldConfig.width - 148 : 148;
    const midCourt = direction === 1 ? 1180 : 420;
    const shortCourt = direction === 1 ? 1010 : 590;
    const minTargetX = Math.min(nearNet, deepCourt);
    const maxTargetX = Math.max(nearNet, deepCourt);
    const heightAboveGround = worldConfig.groundY - this.shuttle.y;
    const lowContact = clamp((180 - heightAboveGround) / 150, 0, 1);
    const highContact = clamp((heightAboveGround - 260) / 260, 0, 1);
    const incomingSpeed = Math.hypot(incomingVelocity.x, incomingVelocity.y);
    const incomingToward = Math.max(0, -direction * incomingVelocity.x);
    const incomingAway = Math.max(0, direction * incomingVelocity.x);
    const sweetness = 1 - clamp(Math.abs(contact.t - 0.74) / 0.42, 0, 1);
    const cleanHit = clamp(quality * 0.72 + sweetness * 0.28, 0, 1);
    const profileByShot = {
      clear: {
        aim: 0.28,
        angle: -0.58,
        baseSpeed: 1260,
        maxSpeed: 1600,
        minForward: 620,
        minSpeed: 1020,
      },
      drive: {
        aim: 0.085,
        angle: -0.02,
        baseSpeed: 1510,
        maxSpeed: 1880,
        minForward: 1060,
        minSpeed: 1240,
      },
      lift: {
        aim: 0.27,
        angle: -0.88,
        baseSpeed: 1120,
        maxSpeed: 1450,
        minForward: 460,
        minSpeed: 900,
      },
      smash: {
        aim: 0.07,
        angle: 0.5,
        baseSpeed: 1780,
        maxSpeed: 2100,
        minForward: 700,
        minSpeed: 1460,
      },
      neutral: {
        aim: 0.24,
        angle: -0.24,
        baseSpeed: 1180,
        maxSpeed: 1500,
        minForward: 600,
        minSpeed: 980,
      },
    } satisfies Record<
      ShotKind,
      {
        aim: number;
        angle: number;
        baseSpeed: number;
        maxSpeed: number;
        minForward: number;
        minSpeed: number;
      }
    >;
    const targetByShot = {
      clear: { x: deepCourt, y: worldConfig.groundY - 78, t: 1.18 },
      drive: {
        x: clamp(opponent.x + direction * 110, minTargetX, maxTargetX),
        y: worldConfig.groundY - 205,
        t: 0.62,
      },
      lift: { x: midCourt, y: worldConfig.groundY - 86, t: 1.08 },
      smash: {
        x: clamp(
          opponent.x - direction * 72,
          Math.min(shortCourt, deepCourt),
          Math.max(shortCourt, deepCourt),
        ),
        y: worldConfig.groundY - 44,
        t: 0.44,
      },
      neutral: { x: midCourt, y: worldConfig.groundY - 150, t: 0.82 },
    } satisfies Record<ShotKind, { x: number; y: number; t: number }>;
    const profile = profileByShot[shot];
    const target = targetByShot[shot];
    const isFastShot = shot === 'drive' || shot === 'smash';
    let launchAngle =
      profile.angle -
      lowContact * 0.22 +
      (shot === 'smash' ? highContact * 0.18 : highContact * 0.04);

    if (forwardInput > 0) {
      launchAngle += shot === 'smash' ? 0.04 : 0.06;
    } else if (forwardInput < 0) {
      launchAngle -= 0.2;
    }

    if (contact.zone === 'handle') {
      launchAngle -= 0.12;
    } else if (contact.zone === 'tip' || contact.zone === 'sweet') {
      launchAngle += shot === 'smash' ? 0.08 : 0.03;
    }

    const intentPower =
      1 +
      (forwardInput > 0 ? 0.1 : 0) +
      (intent.jump || !player.grounded ? 0.08 : 0);
    const slowTouchScale =
      contact.zone === 'edge' || contact.zone === 'handle'
        ? lerp(0.88, 1, clamp(incomingSpeed / 720, 0, 1))
        : 1;
    const borrowedSpeed =
      incomingToward * (0.14 + cleanHit * 0.12) * contact.powerScale -
      incomingAway * (0.04 + (1 - cleanHit) * 0.08);
    const speed =
      (profile.baseSpeed * contact.powerScale * lerp(0.9, 1.13, cleanHit) +
        borrowedSpeed) *
      intentPower *
      slowTouchScale;
    let velocity = {
      x: direction * Math.cos(launchAngle) * speed,
      y: Math.sin(launchAngle) * speed,
    };
    const racketBlend = isFastShot ? 0.025 + cleanHit * 0.025 : 0.045 + cleanHit * 0.035;
    const racketVerticalBlend =
      shot === 'lift' || shot === 'clear' ? 0.03 : isFastShot ? 0.03 : 0.055;
    velocity.x += racketVelocity.x * racketBlend + player.vx * (isFastShot ? 0.12 : 0.18);
    velocity.y +=
      racketVelocity.y * racketVerticalBlend +
      player.vy * (isFastShot ? 0.025 : 0.04) -
      incomingVelocity.y * (0.04 + cleanHit * 0.04);
    velocity.x += -incomingVelocity.x * (0.08 + cleanHit * 0.08);

    const aimStrength =
      profile.aim * lerp(0.55, 1, cleanHit) * clamp(contact.distanceScale, 0.78, 1.16);
    velocity = this.applySimulatedAimCorrection(
      velocity,
      launchPosition,
      target,
      flightProfile,
      dragGraceTimer,
      aimStrength,
      shot,
      contact,
      cleanHit,
    );

    const edgeFlutter =
      contact.zone === 'edge'
        ? Math.sin(this.rallyHits * 1.91 + contact.t * 6) * 42
        : 0;
    velocity.y += edgeFlutter * contact.arcScale;
    const minForward =
      profile.minForward *
      (shot === 'drive' || shot === 'smash' ? lerp(0.9, 1.04, cleanHit) : 1);
    const strictContact = contact.zone === 'edge' || contact.zone === 'handle';
    const fastPeakScale =
      shot === 'smash'
        ? contact.zone === 'sweet'
          ? intent.jump || !player.grounded
            ? 1.12
            : 1.09
          : contact.zone === 'center' || contact.zone === 'tip'
            ? 1.04
            : 1
        : shot === 'drive'
          ? contact.zone === 'sweet'
            ? 1.1
            : contact.zone === 'center' || contact.zone === 'tip'
              ? 1.04
              : 1
          : contact.zone === 'sweet'
            ? 1.03
            : 1;
    const maxSpeed =
      (strictContact ? profile.maxSpeed * 0.98 : profile.maxSpeed * lerp(0.96, 1.06, cleanHit)) *
      fastPeakScale;
    const clampMode: ShotClampMode =
      !strictContact && shot === 'drive'
        ? 'drive'
        : !strictContact && shot === 'smash'
          ? 'smash'
          : 'standard';
    const minDownward =
      shot === 'smash' && velocity.y > 0
        ? velocity.y * (contact.zone === 'sweet' ? 0.88 : 0.8)
        : 0;

    return this.finalizeShotVelocity(
      velocity,
      direction,
      minForward,
      profile.minSpeed * lerp(0.92, 1.04, cleanHit),
      maxSpeed,
      clampMode,
      minDownward,
    );
  }

  private applySimulatedAimCorrection(
    velocity: Vec2,
    start: Vec2,
    target: { x: number; y: number; t: number },
    flightProfile: ShuttleFlightProfile,
    dragGraceTimer: number,
    aimStrength: number,
    shot: ShotKind,
    contact: HitContact,
    cleanHit: number,
  ): Vec2 {
    const original = { ...velocity };
    let corrected = { ...velocity };
    const isFastShot = shot === 'drive' || shot === 'smash';
    const fastContactScale =
      contact.zone === 'sweet'
        ? 0.78
        : contact.zone === 'center' || contact.zone === 'tip'
          ? 0.9
          : 1;
    const horizontalScale = isFastShot
      ? (shot === 'drive' ? 0.42 : 0.36) * fastContactScale
      : flightProfile === 'rally-fast'
        ? 0.72
        : 0.9;
    const verticalScale = isFastShot
      ? (shot === 'drive' ? 0.14 : 0.08) * fastContactScale
      : flightProfile === 'rally-fast'
        ? 0.48
        : 0.78;

    for (let i = 0; i < 2; i += 1) {
      const prediction = this.predictFlightPosition(
        start,
        corrected,
        flightProfile,
        dragGraceTimer,
        target.t,
      );
      const iterationScale = i === 0 ? 1 : 0.55;

      corrected = {
        x:
          corrected.x +
          clamp((target.x - prediction.x) / target.t, -380, 380) *
            aimStrength *
            horizontalScale *
            iterationScale,
        y:
          corrected.y +
          clamp((target.y - prediction.y) / target.t, -320, 320) *
            aimStrength *
            verticalScale *
            iterationScale,
      };
    }

    if (isFastShot) {
      const launchPreserve =
        (contact.zone === 'sweet'
          ? 0.72
          : contact.zone === 'center' || contact.zone === 'tip'
            ? 0.5
            : 0.22) * clamp(cleanHit, 0.3, 1);
      const retainedCorrection = 1 - launchPreserve * 0.62;
      const maxHorizontalDelta = shot === 'drive' ? 68 : 58;
      const maxVerticalDelta = shot === 'drive' ? 24 : 16;
      const direction = original.x >= 0 ? 1 : -1;
      const minimumForward = direction * original.x * (contact.zone === 'sweet' ? 0.96 : 0.92);

      corrected = {
        x:
          original.x +
          clamp((corrected.x - original.x) * retainedCorrection, -maxHorizontalDelta, maxHorizontalDelta),
        y:
          original.y +
          clamp((corrected.y - original.y) * retainedCorrection, -maxVerticalDelta, maxVerticalDelta),
      };

      if (direction * corrected.x < minimumForward) {
        corrected.x = direction * minimumForward;
      }

      if (shot === 'smash' && original.y > 0) {
        corrected.y = Math.max(corrected.y, original.y * (contact.zone === 'sweet' ? 0.94 : 0.9));
      }
    }

    return corrected;
  }

  private predictFlightPosition(
    start: Vec2,
    velocity: Vec2,
    flightProfile: ShuttleFlightProfile,
    dragGraceTimer: number,
    duration: number,
  ): FlightState {
    let state: FlightState = {
      dragGraceTimer,
      flightProfile,
      flightTimer: 0,
      vx: velocity.x,
      vy: velocity.y,
      x: start.x,
      y: start.y,
    };
    let remaining = duration;
    const step = 1 / 120;

    while (remaining > 0) {
      const dt = Math.min(step, remaining);
      state = stepFlightState(state, dt);
      remaining -= dt;

      if (state.y + shuttleConfig.radius >= worldConfig.groundY) {
        return {
          ...state,
          y: worldConfig.groundY - shuttleConfig.radius,
        };
      }
    }

    return state;
  }

  private predictFlightLanding(
    start: Vec2,
    velocity: Vec2,
    flightProfile: ShuttleFlightProfile,
    dragGraceTimer = getFlightDragGrace(flightProfile),
  ): FlightLandingPrediction {
    let state: FlightState = {
      dragGraceTimer,
      flightProfile,
      flightTimer: 0,
      vx: velocity.x,
      vy: velocity.y,
      x: start.x,
      y: start.y,
    };
    const step = 1 / 120;

    for (let i = 0; i < 360; i += 1) {
      state = stepFlightState(state, step);

      if (
        state.y + shuttleConfig.radius >= worldConfig.groundY ||
        state.x < -64 ||
        state.x > worldConfig.width + 64
      ) {
        return {
          flightTime: state.flightTimer,
          landingX: state.x,
        };
      }
    }

    return {
      flightTime: state.flightTimer,
      landingX: state.x,
    };
  }

  private finalizeShotVelocity(
    velocity: Vec2,
    direction: number,
    minForward: number,
    minSpeed: number,
    maxSpeed: number,
    clampMode: ShotClampMode = 'standard',
    minDownward = 0,
  ): Vec2 {
    const forwardSpeed = direction * velocity.x;
    const forwardCorrected =
      forwardSpeed < minForward
        ? {
            ...velocity,
            x: velocity.x + direction * (minForward - forwardSpeed),
          }
        : velocity;

    if (clampMode === 'drive') {
      return this.clampDriveShotVelocity(
        forwardCorrected,
        minSpeed,
        maxSpeed,
        direction,
        minForward,
      );
    }

    if (clampMode === 'smash') {
      return this.clampSmashShotVelocity(
        forwardCorrected,
        minSpeed,
        maxSpeed,
        direction,
        minForward,
        minDownward,
      );
    }

    return this.clampShotVelocity(forwardCorrected, minSpeed, maxSpeed);
  }

  private getRacketContactVelocity(
    previousRacket: { start: Vec2; end: Vec2 },
    racket: { start: Vec2; end: Vec2 },
    t: number,
    dt: number,
  ): Vec2 {
    const previousPoint = pointOnSegment(previousRacket, t);
    const currentPoint = pointOnSegment(racket, t);

    return {
      x: (currentPoint.x - previousPoint.x) / Math.max(dt, 1 / 240),
      y: (currentPoint.y - previousPoint.y) / Math.max(dt, 1 / 240),
    };
  }

  private clampShotVelocity(velocity: Vec2, minSpeed: number, maxSpeed: number): Vec2 {
    const speed = Math.hypot(velocity.x, velocity.y);

    if (speed < minSpeed) {
      const scale = minSpeed / Math.max(speed, 1);
      return {
        x: velocity.x * scale,
        y: velocity.y * scale,
      };
    }

    if (speed > maxSpeed) {
      const scale = maxSpeed / speed;
      return {
        x: velocity.x * scale,
        y: velocity.y * scale,
      };
    }

    return velocity;
  }

  private clampDriveShotVelocity(
    velocity: Vec2,
    minSpeed: number,
    maxSpeed: number,
    direction: number,
    minForward: number,
  ): Vec2 {
    const clamped = this.clampShotVelocity(velocity, minSpeed, maxSpeed);

    if (direction * clamped.x >= minForward) {
      return clamped;
    }

    const forward = Math.min(minForward, maxSpeed);
    const maxY = Math.sqrt(Math.max(0, maxSpeed * maxSpeed - forward * forward));
    const forwardPreserved = {
      x: direction * forward,
      y: clamp(velocity.y, -maxY, maxY),
    };

    return this.clampShotVelocity(forwardPreserved, minSpeed, maxSpeed);
  }

  private clampSmashShotVelocity(
    velocity: Vec2,
    minSpeed: number,
    maxSpeed: number,
    direction: number,
    minForward: number,
    minDownward: number,
  ): Vec2 {
    const clamped = this.clampShotVelocity(velocity, minSpeed, maxSpeed);

    if (
      direction * clamped.x >= minForward &&
      (minDownward <= 0 || clamped.y >= minDownward)
    ) {
      return clamped;
    }

    const downward = minDownward > 0 ? Math.min(minDownward, maxSpeed * 0.96) : Math.max(0, clamped.y);
    const maxForward = Math.sqrt(Math.max(0, maxSpeed * maxSpeed - downward * downward));
    const desiredForward = Math.max(minForward, direction * velocity.x);
    const forward = Math.min(desiredForward, maxForward);
    const smashPreserved = {
      x: direction * forward,
      y: downward,
    };

    return this.clampShotVelocity(smashPreserved, minSpeed, maxSpeed);
  }

  private resolveNetCollision(): void {
    if (this.shuttle.state !== 'flying' || this.shuttle.netCooldown > 0) {
      return;
    }

    const netRect = {
      x: worldConfig.netX - worldConfig.netWidth / 2,
      y: worldConfig.groundY - worldConfig.netHeight,
      width: worldConfig.netWidth,
      height: worldConfig.netHeight,
    };

    if (
      !rectangleContainsCircle(
        this.shuttle.position,
        shuttleConfig.radius,
        netRect,
      )
    ) {
      return;
    }

    const speed = Math.hypot(this.shuttle.vx, this.shuttle.vy);
    const hitTop =
      this.shuttle.previousY + shuttleConfig.radius <= netRect.y &&
      this.shuttle.y + shuttleConfig.radius >= netRect.y &&
      Math.abs(this.shuttle.x - worldConfig.netX) <
        worldConfig.netWidth / 2 + shuttleConfig.radius + 28;
    const hardNetHit = speed > 1320 || Math.abs(this.shuttle.vx) > 1120;

    if (hitTop) {
      this.shuttle.y = netRect.y - shuttleConfig.radius - 1;
      this.shuttle.vx *= hardNetHit ? 0.42 : 0.66;
      this.shuttle.vy = Math.max(
        hardNetHit ? 180 : 86,
        Math.abs(this.shuttle.vy) * (hardNetHit ? 0.18 : 0.28),
      );
      this.lastHitLabel = hardNetHit ? 'Tape Drop' : 'Tape';
    } else {
      this.shuttle.x =
        this.shuttle.x < worldConfig.netX
          ? netRect.x - shuttleConfig.radius
          : netRect.x + netRect.width + shuttleConfig.radius;
      this.shuttle.vx *= hardNetHit ? -0.1 : -0.3;
      this.shuttle.vy = Math.max(
        hardNetHit ? 280 : 120,
        this.shuttle.vy * (hardNetHit ? 0.74 : 0.55),
      );
      this.lastHitLabel = hardNetHit ? 'Net Drop' : 'Net';
    }

    this.shuttle.netCooldown = 0.15;
    this.shuttle.dragGraceTimer = 0;
    this.shuttle.flightTimer += 0.18;
    this.lastHitTimer = 0.5;
  }

  private resolvePointEnd(): void {
    if (this.shuttle.state !== 'flying') {
      return;
    }

    if (this.shuttle.x < -48 || this.shuttle.x > worldConfig.width + 48) {
      this.shuttle.state = 'out';
      this.debugMetrics.flightLandingTime = this.shuttle.flightTimer;
      this.debugMetrics.flightLandingX = this.shuttle.x;
      this.debugMetrics.landingError =
        this.debugMetrics.predictedLandingX >= 0
          ? this.shuttle.x - this.debugMetrics.predictedLandingX
          : 0;
      this.awardPoint(oppositeSide(this.shuttle.lastTouchedBy), 'Out');
      return;
    }

    if (this.shuttle.y + shuttleConfig.radius >= worldConfig.groundY) {
      this.shuttle.state = 'grounded';
      this.debugMetrics.flightLandingTime = this.shuttle.flightTimer;
      this.debugMetrics.flightLandingX = this.shuttle.x;
      this.debugMetrics.landingError =
        this.debugMetrics.predictedLandingX >= 0
          ? this.shuttle.x - this.debugMetrics.predictedLandingX
          : 0;
      const scorer: Side = this.shuttle.x < worldConfig.netX ? 'right' : 'left';
      this.awardPoint(scorer, 'Ground');
    }
  }

  private awardPoint(side: Side, reason: string): void {
    this.score[side] += 1;
    this.server = side;
    this.pointTimer = matchConfig.pointPause;
    this.message = `${side.toUpperCase()} scores - ${reason}`;

    if (this.score[side] >= matchConfig.targetScore) {
      this.winner = side;
      this.phase = 'matchEnd';
      this.message = `${side.toUpperCase()} wins`;
    } else {
      this.phase = 'point';
    }
  }

  private resetMatch(mode: MatchMode, aiDifficulty = this.aiDifficulty): void {
    this.mode = mode;
    if (mode === 'single') {
      this.aiDifficulty = aiDifficulty;
    }
    this.phase = 'playing';
    this.score = { left: 0, right: 0 };
    this.server = 'left';
    this.serveFallbackCount = 0;
    this.winner = null;
    this.message =
      mode === 'single'
        ? `Single Player (${this.getAiDifficultyLabel()} AI): A/D move, W jump, S hit`
        : 'Local Versus: P1 A/D/W/S, P2 arrows/down';
    this.resetPlayers();
    this.resetRally(this.server);
  }

  private resetPlayers(): void {
    this.players.left.x = 320;
    this.players.right.x = 1280;

    for (const player of [this.players.left, this.players.right]) {
      player.y = worldConfig.groundY;
      player.vx = 0;
      player.vy = 0;
      player.grounded = true;
      player.swingType = null;
      player.swingTimer = 0;
      player.swingHasHit = false;
      player.hitIntentJump = false;
      player.hitIntentMove = 0;
      player.hitIntentTimer = 0;
      player.queuedHitTimer = 0;
      player.queuedHitJump = false;
      player.queuedHitMove = 0;
      player.inputFeedbackTimer = 0;
      player.hitHoldCooldown = 0;
      player.hitHoldConsumed = false;
      player.hitInputAge = 0;
      player.readyHitTimer = 0;
      player.waitingForActiveMetric = false;
      player.ai.serveTimer = 0;
      player.ai.decisionTimer = 0;
      player.ai.targetX = player.homeX;
    }
  }

  private resetRally(server: Side): void {
    this.resetPlayers();
    this.rallyHits = 0;
    this.serveDebug = null;
    this.hitStopTimer = 0;
    this.trailBoostPower = 0;
    this.trailBoostTimer = 0;
    this.debugMetrics = {
      flightLandingTime: -1,
      flightLandingX: -1,
      flightNetTime: -1,
      inputToActive: 0,
      landingError: 0,
      launchAngle: 0,
      launchSpeed: 0,
      netAngle: 0,
      netClearance: 0,
      predictedLandingX: -1,
      quality: 0,
      shot: '',
    };
    this.shuttle.attachTo(this.players[server]);
  }

  private drawScreenBackground(
    ctx: CanvasRenderingContext2D,
    viewport: Viewport,
  ): void {
    const gradient = ctx.createLinearGradient(0, 0, 0, viewport.height);
    gradient.addColorStop(0, '#1a2030');
    gradient.addColorStop(1, '#0d1017');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, viewport.width, viewport.height);
  }

  private drawWorld(ctx: CanvasRenderingContext2D): void {
    this.drawCourt(ctx);
    this.drawPlayer(ctx, this.players.left, '#f8fafc');
    this.drawPlayer(ctx, this.players.right, '#facc15');
    this.drawShuttle(ctx);
    this.drawImpact(ctx);
  }

  private drawCourt(ctx: CanvasRenderingContext2D): void {
    const sky = ctx.createLinearGradient(0, 0, 0, worldConfig.groundY);
    sky.addColorStop(0, '#2e6f96');
    sky.addColorStop(0.68, '#b6d7d2');
    sky.addColorStop(1, '#f5f1d6');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, worldConfig.width, worldConfig.groundY);

    ctx.fillStyle = '#304b37';
    ctx.fillRect(0, worldConfig.groundY, worldConfig.width, worldConfig.height - worldConfig.groundY);
    ctx.fillStyle = '#426a46';
    ctx.fillRect(55, worldConfig.groundY - 7, worldConfig.width - 110, 14);

    ctx.strokeStyle = '#edf7de';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(90, worldConfig.groundY);
    ctx.lineTo(worldConfig.width - 90, worldConfig.groundY);
    ctx.moveTo(worldConfig.netX, worldConfig.groundY);
    ctx.lineTo(worldConfig.netX, worldConfig.groundY - worldConfig.netHeight);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,255,255,0.42)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(410, worldConfig.groundY);
    ctx.lineTo(410, worldConfig.groundY - 82);
    ctx.moveTo(1190, worldConfig.groundY);
    ctx.lineTo(1190, worldConfig.groundY - 82);
    ctx.stroke();

    const netTop = worldConfig.groundY - worldConfig.netHeight;
    ctx.strokeStyle = '#f8fafc';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(worldConfig.netX - 8, worldConfig.groundY);
    ctx.lineTo(worldConfig.netX - 8, netTop);
    ctx.moveTo(worldConfig.netX + 8, worldConfig.groundY);
    ctx.lineTo(worldConfig.netX + 8, netTop);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(248,250,252,0.5)';
    ctx.lineWidth = 2;
    for (let y = netTop + 24; y < worldConfig.groundY - 8; y += 24) {
      ctx.beginPath();
      ctx.moveTo(worldConfig.netX - 38, y);
      ctx.lineTo(worldConfig.netX + 38, y);
      ctx.stroke();
    }
  }

  private drawPlayer(
    ctx: CanvasRenderingContext2D,
    player: Player,
    color: string,
  ): void {
    const head = { x: player.x, y: player.y - 160 };
    const hip = { x: player.x, y: player.y - 62 };
    const chest = { x: player.x, y: player.y - 118 };
    const stride = clamp(player.vx / playerConfig.maxSpeed, -1, 1);
    const legSwing = stride * 30;

    ctx.strokeStyle = 'rgba(0,0,0,0.24)';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.ellipse(player.x, player.y + 4, 42, 10, 0, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(head.x, head.y, 25, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(chest.x, chest.y + 24);
    ctx.lineTo(hip.x, hip.y);
    ctx.moveTo(hip.x, hip.y);
    ctx.lineTo(player.x - 28 - legSwing, player.y - 5);
    ctx.moveTo(hip.x, hip.y);
    ctx.lineTo(player.x + 28 - legSwing, player.y - 5);
    ctx.stroke();

    const racket = player.getRacketLine();
    const offHandX = player.x - player.facing * 40;
    const hasInputFeedback = player.inputFeedbackTimer > 0;
    const hasQueuedHit = player.queuedHitTimer > 0;
    const hasReadyHit = player.readyHitTimer > 0;
    const isSwingActive = player.swingPhase === 'active';
    ctx.beginPath();
    ctx.moveTo(chest.x, chest.y + 20);
    ctx.lineTo(offHandX, chest.y + 48);
    ctx.moveTo(chest.x, chest.y + 20);
    ctx.lineTo(racket.start.x, racket.start.y);
    ctx.stroke();

    ctx.strokeStyle =
      isSwingActive
        ? '#38f7ff'
        : hasInputFeedback || hasQueuedHit
          ? '#fef08a'
          : hasReadyHit
            ? '#67e8f9'
          : 'rgba(17,24,39,0.82)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(racket.start.x, racket.start.y);
    ctx.lineTo(racket.end.x, racket.end.y);
    ctx.stroke();
    ctx.strokeStyle =
      isSwingActive || hasInputFeedback || hasReadyHit ? '#ffffff' : 'rgba(15,23,42,0.9)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(
      racket.end.x,
      racket.end.y,
      28,
      42,
      0.2 * player.facing,
      0,
      Math.PI * 2,
    );
    ctx.stroke();

    if (hasInputFeedback || hasQueuedHit || hasReadyHit) {
      const pulse = hasInputFeedback
        ? player.inputFeedbackTimer / 0.14
        : hasQueuedHit
          ? clamp(player.queuedHitTimer / racketConfig.hitBuffer, 0, 1)
          : 0.5;
      ctx.strokeStyle = hasQueuedHit
        ? `rgba(254,240,138,${0.78 * pulse})`
        : `rgba(56,247,255,${0.68 * pulse})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(
        racket.start.x + player.facing * 44,
        racket.start.y - 8,
        16 + (1 - pulse) * 13,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }
  }

  private drawShuttle(ctx: CanvasRenderingContext2D): void {
    const angle = Math.atan2(this.shuttle.vy, this.shuttle.vx);

    ctx.save();
    ctx.translate(this.shuttle.x, this.shuttle.y);
    ctx.rotate(Number.isFinite(angle) ? angle : 0);

    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.arc(13, 0, 8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#f8fafc';
    ctx.beginPath();
    ctx.moveTo(4, -12);
    ctx.lineTo(-28, -22);
    ctx.lineTo(-22, 0);
    ctx.lineTo(-28, 22);
    ctx.lineTo(4, 12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (this.shuttle.state === 'flying') {
      const boost = this.trailBoostTimer > 0 ? clamp(this.trailBoostPower, 1, 1.6) : 0;
      const trailScale = boost > 0 ? 0.12 + boost * 0.035 : 0.08;
      ctx.strokeStyle =
        boost > 0
          ? `rgba(255,246,170,${clamp(0.28 + boost * 0.2, 0.35, 0.62)})`
          : 'rgba(255,255,255,0.28)';
      ctx.lineWidth = boost > 0 ? 4 + boost * 2.2 : 3;
      ctx.beginPath();
      ctx.moveTo(this.shuttle.x, this.shuttle.y);
      ctx.lineTo(
        this.shuttle.x - this.shuttle.vx * trailScale,
        this.shuttle.y - this.shuttle.vy * trailScale,
      );
      ctx.stroke();
    }
  }

  private drawImpact(ctx: CanvasRenderingContext2D): void {
    if (this.impactTimer <= 0) {
      return;
    }

    const progress = clamp(this.impactTimer / 0.18, 0, 1);
    const radius = 18 + (1 - progress) * 48 * this.impactPower;
    const flash = this.impactPower > 1.08 ? '255,246,170' : '255,255,255';
    ctx.save();
    ctx.translate(this.impactX, this.impactY);
    ctx.strokeStyle = `rgba(${flash},${0.84 * progress})`;
    ctx.lineWidth = 4 + this.impactPower * 1.8;

    for (let i = 0; i < 8; i += 1) {
      const angle = (Math.PI * 2 * i) / 8;
      const inner = radius * 0.34;
      const outer = radius;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
      ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
      ctx.stroke();
    }

    ctx.restore();
  }

  private drawHud(ctx: CanvasRenderingContext2D): void {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(15,23,42,0.58)';
    ctx.fillRect(548, 24, 504, 92);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 54px Inter, sans-serif';
    ctx.fillText(
      `${this.score.left}   ${this.score.right}`,
      worldConfig.width / 2,
      64,
    );
    ctx.font = '600 22px Inter, sans-serif';
    ctx.fillText(
      `${this.getModeLabel()} | Serve: ${this.server.toUpperCase()} | Rally: ${this.rallyHits}`,
      worldConfig.width / 2,
      100,
    );

    if (this.lastHitTimer > 0) {
      ctx.font = '700 32px Inter, sans-serif';
      ctx.fillStyle = '#0f172a';
      ctx.fillText(this.lastHitLabel, worldConfig.width / 2, 152);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(this.lastHitLabel, worldConfig.width / 2, 148);
    }
  }

  private drawPhaseOverlay(ctx: CanvasRenderingContext2D): void {
    if (!this.message && this.phase === 'playing') {
      return;
    }

    const isAttached =
      this.shuttle.state === 'attached' && this.phase === 'playing';
    const text = isAttached
      ? `${this.server.toUpperCase()} serve`
      : this.phase === 'matchEnd' && this.winner
        ? `${this.winner.toUpperCase()} wins`
        : this.message;
    const hint =
      this.phase === 'paused'
        ? 'Enter/P to resume, R restart, M menu'
        : this.phase === 'matchEnd'
          ? 'Enter/R rematch, M menu'
          : isAttached
            ? this.getServeHint()
            : '';

    if (!text) {
      return;
    }

    ctx.fillStyle = 'rgba(15,23,42,0.54)';
    ctx.fillRect(456, 304, 688, 138);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 40px Inter, sans-serif';
    ctx.fillText(text, worldConfig.width / 2, 352);
    ctx.font = '500 22px Inter, sans-serif';
    ctx.fillText(hint, worldConfig.width / 2, 400);
  }

  private getServeHint(): string {
    if (this.mode === 'single' && this.server === 'right') {
      return `${this.getAiDifficultyLabel()} AI serving`;
    }

    return this.server === 'left' ? 'Press S to serve' : 'Press Down to serve';
  }

  private getModeLabel(): string {
    return this.mode === 'single'
      ? `Single ${this.getAiDifficultyLabel()}`
      : 'Versus';
  }

  private getAiDifficultyLabel(): string {
    return this.aiDifficulty === 'boss' ? 'Boss' : 'Normal';
  }

  private drawMenu(ctx: CanvasRenderingContext2D): void {
    ctx.fillStyle = 'rgba(8,13,23,0.54)';
    ctx.fillRect(0, 0, worldConfig.width, worldConfig.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 74px Inter, sans-serif';
    ctx.fillText('Stick Shuttle Duel', worldConfig.width / 2, 245);
    ctx.font = '500 28px Inter, sans-serif';
    ctx.fillText('Arcade badminton prototype', worldConfig.width / 2, 306);

    this.drawMenuButton(ctx, 1, 'AI Normal', 392);
    this.drawMenuButton(ctx, 2, 'AI Demon King', 484);
    this.drawMenuButton(ctx, 3, 'Local Versus', 576);

    ctx.font = '500 23px Inter, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fillText('P1: A/D move, W jump, S hit', worldConfig.width / 2, 684);
    ctx.fillText('P2: arrows move/jump, Down hit', worldConfig.width / 2, 724);
    ctx.fillText('P pause, R restart, H debug', worldConfig.width / 2, 764);
  }

  private drawMenuButton(
    ctx: CanvasRenderingContext2D,
    key: number,
    label: string,
    y: number,
  ): void {
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.fillRect(560, y - 36, 480, 72);
    ctx.fillStyle = '#0f172a';
    ctx.font = '700 28px Inter, sans-serif';
    ctx.fillText(`${key}. ${label}`, worldConfig.width / 2, y);
  }

  private drawDebug(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ff3b7f';
    for (const player of [this.players.left, this.players.right]) {
      const racket = player.getRacketLine();
      ctx.beginPath();
      ctx.moveTo(racket.start.x, racket.start.y);
      ctx.lineTo(racket.end.x, racket.end.y);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(
        racket.end.x,
        racket.end.y,
        racketConfig.hitRadius,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
    }

    ctx.strokeStyle = '#38f7ff';
    ctx.beginPath();
    ctx.arc(
      this.shuttle.x,
      this.shuttle.y,
      shuttleConfig.radius,
      0,
      Math.PI * 2,
    );
    ctx.stroke();

    if (this.serveDebug) {
      ctx.strokeStyle = this.serveDebug.valid ? '#a3e635' : '#fb7185';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(this.serveDebug.landingX, worldConfig.groundY);
      ctx.lineTo(this.serveDebug.landingX, worldConfig.groundY - 70);
      ctx.stroke();

      ctx.strokeStyle = 'rgba(250,204,21,0.8)';
      ctx.beginPath();
      ctx.moveTo(this.serveDebug.targetX, worldConfig.groundY);
      ctx.lineTo(this.serveDebug.targetX, worldConfig.groundY - 92);
      ctx.stroke();
    }

    ctx.fillStyle = 'rgba(15,23,42,0.72)';
    ctx.fillRect(24, 24, 500, this.serveDebug ? 608 : 378);
    ctx.fillStyle = '#ffffff';
    ctx.font = '500 20px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Phase: ${this.phase}`, 44, 55);
    ctx.fillText(`Ball: ${Math.round(this.shuttle.vx)}, ${Math.round(this.shuttle.vy)}`, 44, 84);
    ctx.fillText(`State: ${this.shuttle.state}`, 44, 113);
    ctx.fillText(`Input->active: ${this.debugMetrics.inputToActive.toFixed(3)}s`, 44, 142);
    ctx.fillText(`Swing total: ${this.players.left.swingDuration.toFixed(3)}s`, 44, 171);
    ctx.fillText(
      `Cancel at: ${(racketConfig.windup + racketConfig.active + racketConfig.recovery * racketConfig.recoveryCancel).toFixed(3)}s`,
      44,
      200,
    );
    ctx.fillText(
      `Net/land time: ${formatDebugTime(this.debugMetrics.flightNetTime)} / ${formatDebugTime(this.debugMetrics.flightLandingTime)}`,
      44,
      229,
    );
    ctx.fillText(
      `Landing x: ${this.debugMetrics.flightLandingX >= 0 ? Math.round(this.debugMetrics.flightLandingX) : '--'}`,
      44,
      258,
    );
    ctx.fillText(
      `Shot: ${this.debugMetrics.shot || '--'} | q ${this.debugMetrics.quality.toFixed(2)} | v ${Math.round(this.debugMetrics.launchSpeed)}`,
      44,
      287,
    );
    ctx.fillText(`Net clearance: ${Math.round(this.debugMetrics.netClearance)} px`, 44, 316);
    ctx.fillText(
      `Pred/err: ${
        this.debugMetrics.predictedLandingX >= 0
          ? Math.round(this.debugMetrics.predictedLandingX)
          : '--'
      } / ${Math.round(this.debugMetrics.landingError)}`,
      44,
      345,
    );
    ctx.fillText(
      `Angle: ${this.debugMetrics.launchAngle.toFixed(1)} / ${this.debugMetrics.netAngle.toFixed(1)}`,
      44,
      374,
    );

    if (this.serveDebug) {
      ctx.fillText(
        `Serve land/target/err: ${Math.round(this.serveDebug.landingX)} / ${Math.round(this.serveDebug.targetX)} / ${Math.round(this.serveDebug.landingError)}`,
        44,
        403,
      );
      ctx.fillText(
        `Net clearance: ${Math.round(this.serveDebug.netClearance)} px`,
        44,
        432,
      );
      ctx.fillText(
        `Serve time: ${this.serveDebug.flightTime.toFixed(2)}s ${this.serveDebug.valid ? 'OK' : 'CHECK'}`,
        44,
        461,
      );
      ctx.fillText(
        `Serve mode: ${this.serveDebug.mode}`,
        44,
        490,
      );
      ctx.fillText(
        `Serve fallback: ${this.serveDebug.fallbackUsed ? 'yes' : 'no'}`,
        44,
        519,
      );
      ctx.fillText(
        `Fallback reason: ${this.serveDebug.fallbackReason}`,
        44,
        548,
      );
      ctx.fillText(
        `Fallback count: ${this.serveDebug.totalFallbacks}`,
        44,
        577,
      );
    }
    ctx.restore();
  }

  private isDown(code: string): boolean {
    return this.input.down.has(code);
  }

  private wasPressed(code: string): boolean {
    if (this.consumedPressed.has(code) || !this.input.pressed.has(code)) {
      return false;
    }

    this.consumedPressed.add(code);
    return true;
  }
}

const oppositeSide = (side: Side): Side => (side === 'left' ? 'right' : 'left');

const pointOnSegment = (
  line: { start: Vec2; end: Vec2 },
  t: number,
): Vec2 => ({
  x: lerp(line.start.x, line.end.x, t),
  y: lerp(line.start.y, line.end.y, t),
});

const midpoint = (a: Vec2, b: Vec2): Vec2 => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

const velocityAngleDegrees = (velocity: Vec2): number =>
  (Math.atan2(velocity.y, Math.max(Math.abs(velocity.x), 0.001)) * 180) / Math.PI;

const approach = (value: number, target: number, maxDelta: number): number => {
  if (value < target) {
    return Math.min(target, value + maxDelta);
  }

  return Math.max(target, value - maxDelta);
};

const formatDebugTime = (time: number): string =>
  time >= 0 ? `${time.toFixed(2)}s` : '--';
