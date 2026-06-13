import { createAiIntent } from './ai-controller';
import {
  matchConfig,
  playerConfig,
  racketConfig,
  shuttleConfig,
  worldConfig,
} from './config';
import { Player, Shuttlecock } from './entities';
import {
  clamp,
  lerp,
  projectPointToSegment,
  rectangleContainsCircle,
  sideDirection,
} from './math';
import type {
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

interface FlightState {
  dragGraceTimer: number;
  flightProfile: ShuttleFlightProfile;
  flightTimer: number;
  vx: number;
  vy: number;
  x: number;
  y: number;
}

interface ServePrediction {
  flightTime: number;
  landingX: number;
  netClearance: number;
  valid: boolean;
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
  private score = { left: 0, right: 0 };
  private server: Side = 'left';
  private winner: Side | null = null;
  private pointTimer = 0;
  private rallyHits = 0;
  private debug = false;
  private message = 'Press 1 for Single Player or 2 for Local Versus';
  private lastHitLabel = '';
  private lastHitTimer = 0;
  private impactX = 0;
  private impactY = 0;
  private impactPower = 1;
  private impactTimer = 0;
  private serveDebug:
    | {
        flightTime: number;
        landingX: number;
        netClearance: number;
        targetX: number;
        valid: boolean;
      }
    | null = null;

  constructor(initialMode?: MatchMode) {
    this.resetMatch('single');
    if (!initialMode) {
      this.phase = 'menu';
      this.message = 'Press 1 for Single Player or 2 for Local Versus';
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

    this.lastHitTimer = Math.max(0, this.lastHitTimer - dt);
    this.impactTimer = Math.max(0, this.impactTimer - dt);

    switch (this.phase) {
      case 'menu':
        this.updateMenu();
        break;
      case 'playing':
        this.updatePlaying(dt);
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
      this.resetMatch('single');
      return;
    }

    if (this.wasPressed('Digit2')) {
      this.resetMatch('versus');
    }
  }

  private updatePlaying(dt: number): void {
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
      const intent = this.server === 'left' ? leftIntent : rightIntent;
      this.shuttle.updateAttached(serverPlayer);

      if (intent.hitPressed) {
        this.launchServe(serverPlayer);
      }

      return;
    }

    this.updateShuttle(dt);
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
      this.message = 'Press 1 for Single Player or 2 for Local Versus';
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
      this.message = 'Press 1 for Single Player or 2 for Local Versus';
    }
  }

  private getControllerIntent(player: Player, dt: number): PlayerIntent {
    if (this.mode === 'single' && player.side === 'right') {
      return createAiIntent(player, this.players.left, this.shuttle, dt);
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

    const acceleration =
      playerConfig.acceleration * (player.grounded ? 1 : playerConfig.airControl);
    player.vx += intent.move * acceleration * dt;

    if (intent.move === 0 && player.grounded) {
      const friction = Math.exp(-playerConfig.groundFriction * dt);
      player.vx *= friction;
    }

    player.vx = clamp(
      player.vx,
      -playerConfig.maxSpeed,
      playerConfig.maxSpeed,
    );

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
    }

    player.hitIntentTimer = Math.max(0, player.hitIntentTimer - dt);
    player.queuedHitTimer = Math.max(0, player.queuedHitTimer - dt);
    player.inputFeedbackTimer = Math.max(0, player.inputFeedbackTimer - dt);
    const wasSwinging = player.isSwinging;
    const swingHadHit = player.swingHasHit;
    player.updateSwing(dt);

    const startedQueuedSwing = this.tryStartQueuedSwing(player);

    if (wasSwinging && !player.isSwinging && !swingHadHit && !startedQueuedSwing) {
      this.showSwingMiss(player);
    }
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
  }

  private promoteQueuedHit(player: Player): void {
    player.hitIntentMove = player.queuedHitMove;
    player.hitIntentJump = player.queuedHitJump;
    player.hitIntentTimer = player.swingDuration + 0.04;
    player.queuedHitTimer = 0;
  }

  private launchServe(player: Player): void {
    const direction = sideDirection(player.side);
    const start = {
      x: player.x + direction * 90,
      y: player.y - 136,
    };
    const targetX = direction === 1 ? 1210 : 390;
    const serve = this.solveServeVelocity(start, direction, targetX);

    this.shuttle.state = 'flying';
    this.shuttle.lastTouchedBy = player.side;
    this.shuttle.attachedTo = player.side;
    this.shuttle.x = start.x;
    this.shuttle.y = start.y;
    this.shuttle.previousX = this.shuttle.x;
    this.shuttle.previousY = this.shuttle.y;
    this.shuttle.vx = serve.velocity.x;
    this.shuttle.vy = serve.velocity.y;
    this.shuttle.dragGraceTimer = shuttleConfig.serveDragGrace;
    this.shuttle.flightTimer = 0;
    this.shuttle.flightProfile = 'serve';
    this.serveDebug = {
      flightTime: serve.prediction.flightTime,
      landingX: serve.prediction.landingX,
      netClearance: serve.prediction.netClearance,
      targetX,
      valid: serve.prediction.valid,
    };
    this.rallyHits = 0;
    this.message = '';
  }

  private solveServeVelocity(
    start: Vec2,
    direction: number,
    targetX: number,
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
          const prediction = this.predictServe(start, velocity);
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

  private predictServe(start: Vec2, velocity: Vec2): ServePrediction {
    const step = 1 / 120;
    const netTop = worldConfig.groundY - worldConfig.netHeight;
    let state: FlightState = {
      dragGraceTimer: shuttleConfig.serveDragGrace,
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
      state = this.stepFlightState(state, step);

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

  private stepFlightState(state: FlightState, dt: number): FlightState {
    const graceDuration =
      state.flightProfile === 'serve'
        ? shuttleConfig.serveDragGrace
        : shuttleConfig.postHitDragGrace;
    const lateHorizontalScale =
      state.flightProfile === 'serve'
        ? shuttleConfig.serveLateHorizontalDragScale
        : shuttleConfig.lateHorizontalDragScale;
    const lateStart = state.flightProfile === 'serve' ? 0.5 : 0.24;
    const lateDuration = state.flightProfile === 'serve' ? 0.82 : 0.48;
    const dragProgress = clamp(
      1 - state.dragGraceTimer / Math.max(graceDuration, 0.001),
      0,
      1,
    );
    const smoothProgress = smoothstep(dragProgress);
    const lateProgress = smoothstep(
      clamp((state.flightTimer - lateStart) / lateDuration, 0, 1),
    );
    const startDragScale = lerp(
      shuttleConfig.initialDragScale,
      1,
      smoothProgress,
    );
    const horizontalDragScale = lerp(
      startDragScale,
      lateHorizontalScale,
      lateProgress,
    );
    const verticalDragScale =
      state.vy > 0
        ? lerp(startDragScale, shuttleConfig.descentDragScale, lateProgress)
        : startDragScale;
    const horizontalDrag =
      1 -
      Math.min(
        0.84,
        (shuttleConfig.horizontalLinearDrag +
          shuttleConfig.horizontalQuadraticDrag * Math.abs(state.vx)) *
          horizontalDragScale *
          dt,
      );
    const verticalDrag =
      1 -
      Math.min(
        0.72,
        (shuttleConfig.verticalLinearDrag +
          shuttleConfig.verticalQuadraticDrag * Math.abs(state.vy)) *
          verticalDragScale *
          dt,
      );
    let vx = state.vx * horizontalDrag;
    let vy = Math.min(
      state.vy * verticalDrag + shuttleConfig.gravity * dt,
      shuttleConfig.maxFallSpeed,
    );
    const speed = Math.hypot(vx, vy);

    if (speed > shuttleConfig.maxSpeed) {
      const scale = shuttleConfig.maxSpeed / speed;
      vx *= scale;
      vy *= scale;
    }

    return {
      ...state,
      dragGraceTimer: Math.max(0, state.dragGraceTimer - dt),
      flightTimer: state.flightTimer + dt,
      vx,
      vy,
      x: state.x + vx * dt,
      y: state.y + vy * dt,
    };
  }

  private updateShuttle(dt: number): void {
    if (this.shuttle.state !== 'flying') {
      return;
    }

    this.shuttle.previousX = this.shuttle.x;
    this.shuttle.previousY = this.shuttle.y;

    const next = this.stepFlightState(
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
    const velocity = this.getShotVelocity(
      player,
      shot,
      quality,
      contact,
      lockedIntent,
      racketVelocity,
      incomingVelocity,
    );

    player.swingHasHit = true;
    player.hitIntentTimer = 0;
    this.shuttle.lastTouchedBy = player.side;
    this.shuttle.vx = velocity.x;
    this.shuttle.vy = velocity.y;
    this.shuttle.dragGraceTimer = shuttleConfig.postHitDragGrace;
    this.shuttle.flightTimer = 0;
    this.shuttle.flightProfile = 'rally';
    this.shuttle.x = contact.point.x + sideDirection(player.side) * 18;
    this.shuttle.y = clamp(
      contact.point.y,
      player.y - racketConfig.assistHeightMax,
      player.y - racketConfig.assistHeightMin,
    );
    this.shuttle.previousX = this.shuttle.x;
    this.shuttle.previousY = this.shuttle.y;
    this.rallyHits += 1;
    this.lastHitLabel = `${contact.label} ${shot}`;
    this.lastHitTimer = 0.72;
    this.impactX = this.shuttle.x;
    this.impactY = this.shuttle.y;
    this.impactPower = contact.powerScale * (contact.zone === 'sweet' ? 1.18 : 1);
    this.impactTimer = shot === 'smash' ? 0.22 : 0.16;
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
      handle: { arcScale: 1.1, distanceScale: 0.88, label: 'Handle', powerScale: 0.86 },
      center: { arcScale: 1, distanceScale: 1, label: 'Center', powerScale: 1.04 },
      sweet: { arcScale: 0.92, distanceScale: 1.12, label: 'Sweet', powerScale: 1.22 },
      tip: { arcScale: 0.9, distanceScale: 1.08, label: 'Tip', powerScale: 1.14 },
      edge: { arcScale: 1.14, distanceScale: 0.8, label: 'Edge', powerScale: 0.78 },
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
    const netTop = worldConfig.groundY - worldConfig.netHeight;
    const heightAboveGround = worldConfig.groundY - this.shuttle.y;
    const nearNet = Math.abs(this.shuttle.x - worldConfig.netX) < 150;
    const direction = sideDirection(player.side);
    const movingForward = direction * player.vx > 80 || direction * intent.move > 0;
    const movingBack = direction * intent.move < 0;

    if (
      (!player.grounded || intent.jump) &&
      contact.t > 0.62 &&
      this.shuttle.y < netTop - 10 &&
      heightAboveGround > 230
    ) {
      return 'smash';
    }

    if (movingForward && contact.zone !== 'handle' && heightAboveGround > 120) {
      return 'drive';
    }

    if (movingBack || contact.zone === 'handle' || heightAboveGround < 150) {
      return 'lift';
    }

    if (nearNet && this.shuttle.y > netTop - 20) {
      return 'drive';
    }

    if (heightAboveGround > 285 && contact.zone !== 'tip') {
      return 'clear';
    }

    if (contact.zone === 'tip' || contact.zone === 'sweet') {
      return 'drive';
    }

    return 'neutral';
  }

  private getShotVelocity(
    player: Player,
    shot: ShotKind,
    quality: number,
    contact: HitContact,
    intent: HitIntentLock,
    racketVelocity: Vec2,
    incomingVelocity: Vec2,
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
        aim: 0.24,
        angle: -0.58,
        baseSpeed: 1180,
        maxSpeed: 1500,
        minForward: 620,
        minSpeed: 930,
      },
      drive: {
        aim: 0.17,
        angle: -0.06,
        baseSpeed: 1380,
        maxSpeed: 1780,
        minForward: 980,
        minSpeed: 1120,
      },
      lift: {
        aim: 0.22,
        angle: -0.88,
        baseSpeed: 1080,
        maxSpeed: 1380,
        minForward: 460,
        minSpeed: 840,
      },
      smash: {
        aim: 0.12,
        angle: 0.46,
        baseSpeed: 1640,
        maxSpeed: 2050,
        minForward: 700,
        minSpeed: 1320,
      },
      neutral: {
        aim: 0.2,
        angle: -0.24,
        baseSpeed: 1050,
        maxSpeed: 1350,
        minForward: 520,
        minSpeed: 820,
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
    const velocity = {
      x: direction * Math.cos(launchAngle) * speed,
      y: Math.sin(launchAngle) * speed,
    };
    const racketBlend = 0.13 + cleanHit * 0.08;
    velocity.x += racketVelocity.x * racketBlend + player.vx * 0.22;
    velocity.y +=
      racketVelocity.y * (shot === 'lift' || shot === 'clear' ? 0.045 : 0.095) +
      player.vy * 0.04 -
      incomingVelocity.y * (0.04 + cleanHit * 0.04);
    velocity.x += -incomingVelocity.x * (0.08 + cleanHit * 0.08);

    const aimVelocity = {
      x: (target.x - this.shuttle.x) / target.t,
      y:
        (target.y -
          this.shuttle.y -
          0.5 * shuttleConfig.gravity * target.t * target.t) /
        target.t,
    };
    const aimStrength =
      profile.aim * lerp(0.55, 1, cleanHit) * clamp(contact.distanceScale, 0.78, 1.16);
    velocity.x +=
      clamp(aimVelocity.x - velocity.x, -320, 320) * aimStrength;
    velocity.y +=
      clamp(aimVelocity.y - velocity.y, -260, 260) * aimStrength;

    const edgeFlutter =
      contact.zone === 'edge'
        ? Math.sin(this.rallyHits * 1.91 + contact.t * 6) * 42
        : 0;
    velocity.y += edgeFlutter * contact.arcScale;
    const clamped = this.clampShotVelocity(
      velocity,
      profile.minSpeed * lerp(0.92, 1.04, cleanHit),
      profile.maxSpeed * lerp(0.96, 1.06, cleanHit),
    );
    const forwardSpeed = direction * clamped.x;
    const minForward =
      profile.minForward *
      (shot === 'drive' || shot === 'smash' ? lerp(0.9, 1.04, cleanHit) : 1);

    if (forwardSpeed < minForward) {
      clamped.x += direction * (minForward - forwardSpeed) * 0.55;
    }

    return clamped;
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
      this.awardPoint(oppositeSide(this.shuttle.lastTouchedBy), 'Out');
      return;
    }

    if (this.shuttle.y + shuttleConfig.radius >= worldConfig.groundY) {
      this.shuttle.state = 'grounded';
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

  private resetMatch(mode: MatchMode): void {
    this.mode = mode;
    this.phase = 'playing';
    this.score = { left: 0, right: 0 };
    this.server = 'left';
    this.winner = null;
    this.message =
      mode === 'single'
        ? 'Single Player: A/D move, W jump, S hit'
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
      player.ai.serveTimer = 0;
      player.ai.decisionTimer = 0;
      player.ai.targetX = player.homeX;
    }
  }

  private resetRally(server: Side): void {
    this.resetPlayers();
    this.rallyHits = 0;
    this.serveDebug = null;
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
          : 'rgba(17,24,39,0.82)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(racket.start.x, racket.start.y);
    ctx.lineTo(racket.end.x, racket.end.y);
    ctx.stroke();
    ctx.strokeStyle =
      isSwingActive || hasInputFeedback ? '#ffffff' : 'rgba(15,23,42,0.9)';
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

    if (hasInputFeedback || hasQueuedHit) {
      const pulse = hasInputFeedback
        ? player.inputFeedbackTimer / 0.14
        : clamp(player.queuedHitTimer / racketConfig.hitBuffer, 0, 1);
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
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(this.shuttle.x, this.shuttle.y);
      ctx.lineTo(
        this.shuttle.x - this.shuttle.vx * 0.08,
        this.shuttle.y - this.shuttle.vy * 0.08,
      );
      ctx.stroke();
    }
  }

  private drawImpact(ctx: CanvasRenderingContext2D): void {
    if (this.impactTimer <= 0) {
      return;
    }

    const progress = this.impactTimer / 0.18;
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
      `${this.mode === 'single' ? 'Single' : 'Versus'} | Serve: ${this.server.toUpperCase()} | Rally: ${this.rallyHits}`,
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
      return 'AI serving';
    }

    return this.server === 'left' ? 'Press S to serve' : 'Press Down to serve';
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

    this.drawMenuButton(ctx, 1, 'Single Player', 412);
    this.drawMenuButton(ctx, 2, 'Local Versus', 504);

    ctx.font = '500 23px Inter, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.82)';
    ctx.fillText('P1: A/D move, W jump, S hit', worldConfig.width / 2, 632);
    ctx.fillText('P2: arrows move/jump, Down hit', worldConfig.width / 2, 672);
    ctx.fillText('P pause, R restart, H debug', worldConfig.width / 2, 712);
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
    ctx.fillRect(24, 24, 420, this.serveDebug ? 192 : 120);
    ctx.fillStyle = '#ffffff';
    ctx.font = '500 20px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Phase: ${this.phase}`, 44, 55);
    ctx.fillText(`Ball: ${Math.round(this.shuttle.vx)}, ${Math.round(this.shuttle.vy)}`, 44, 84);
    ctx.fillText(`State: ${this.shuttle.state}`, 44, 113);

    if (this.serveDebug) {
      ctx.fillText(
        `Serve land/target: ${Math.round(this.serveDebug.landingX)} / ${Math.round(this.serveDebug.targetX)}`,
        44,
        142,
      );
      ctx.fillText(
        `Net clearance: ${Math.round(this.serveDebug.netClearance)} px`,
        44,
        171,
      );
      ctx.fillText(
        `Serve time: ${this.serveDebug.flightTime.toFixed(2)}s ${this.serveDebug.valid ? 'OK' : 'CHECK'}`,
        44,
        200,
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

const smoothstep = (value: number): number => {
  const t = clamp(value, 0, 1);

  return t * t * (3 - 2 * t);
};
