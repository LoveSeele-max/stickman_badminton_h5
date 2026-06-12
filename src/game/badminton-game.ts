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
  distancePointToSegment,
  rectangleContainsCircle,
  sideDirection,
} from './math';
import type {
  GamePhase,
  InputSnapshot,
  MatchMode,
  PlayerIntent,
  ShotKind,
  Side,
  Viewport,
} from './types';

const emptySnapshot: InputSnapshot = {
  down: new Set<string>(),
  pressed: new Set<string>(),
};

const emptyIntent: PlayerIntent = {
  move: 0,
  aimForward: 0,
  aimVertical: 0,
  jump: false,
  jumpPressed: false,
  swingPressed: false,
  powerPressed: false,
  pausePressed: false,
};

export class BadmintonGame {
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
  }

  update(dt: number): void {
    if (this.wasPressed('KeyH') || this.wasPressed('Backquote')) {
      this.debug = !this.debug;
    }

    this.lastHitTimer = Math.max(0, this.lastHitTimer - dt);

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

      if (intent.swingPressed || intent.powerPressed) {
        this.launchServe(serverPlayer);
      }

      return;
    }

    this.updateShuttle(dt);
    this.resolveRacketHits();
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
            down: 'KeyS',
            up: 'KeyW',
            swing: 'KeyF',
            power: 'KeyG',
          }
        : {
            left: 'ArrowLeft',
            right: 'ArrowRight',
            down: 'ArrowDown',
            up: 'ArrowUp',
            swing: 'KeyK',
            power: 'KeyL',
          };
    const moveWorld =
      (this.isDown(keys.right) ? 1 : 0) - (this.isDown(keys.left) ? 1 : 0);
    const towardNet = sideDirection(side);
    const aimForward = moveWorld === 0 ? 0 : moveWorld === towardNet ? 1 : -1;
    const aimVertical =
      (this.isDown(keys.down) ? 1 : 0) - (this.isDown(keys.up) ? 1 : 0);

    return {
      move: moveWorld,
      aimForward,
      aimVertical,
      jump: this.isDown(keys.up),
      jumpPressed: this.wasPressed(keys.up),
      swingPressed: this.wasPressed(keys.swing),
      powerPressed: this.wasPressed(keys.power),
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

    if (intent.powerPressed) {
      player.startSwing('power');
    } else if (intent.swingPressed) {
      player.startSwing('normal');
    }

    player.updateSwing(dt);
  }

  private launchServe(player: Player): void {
    const direction = sideDirection(player.side);
    this.shuttle.state = 'flying';
    this.shuttle.lastTouchedBy = player.side;
    this.shuttle.attachedTo = player.side;
    this.shuttle.x = player.x + direction * 90;
    this.shuttle.y = player.y - 136;
    this.shuttle.vx = direction * 560;
    this.shuttle.vy = -560;
    this.rallyHits = 0;
    this.message = '';
  }

  private updateShuttle(dt: number): void {
    if (this.shuttle.state !== 'flying') {
      return;
    }

    const speed = Math.hypot(this.shuttle.vx, this.shuttle.vy);
    const drag =
      1 - Math.min(0.86, (shuttleConfig.linearDrag + shuttleConfig.quadraticDrag * speed) * dt);
    this.shuttle.vx *= drag;
    this.shuttle.vy = this.shuttle.vy * drag + shuttleConfig.gravity * dt;
    this.shuttle.clampSpeed();
    this.shuttle.x += this.shuttle.vx * dt;
    this.shuttle.y += this.shuttle.vy * dt;
    this.shuttle.netCooldown = Math.max(0, this.shuttle.netCooldown - dt);
  }

  private resolveRacketHits(): void {
    if (this.shuttle.state !== 'flying') {
      return;
    }

    this.tryHitWithPlayer(this.players.left);
    this.tryHitWithPlayer(this.players.right);
  }

  private tryHitWithPlayer(player: Player): void {
    if (
      player.swingPhase !== 'active' ||
      player.swingHasHit ||
      sideDirection(player.side) * (this.shuttle.x - player.x) < -20
    ) {
      return;
    }

    const racket = player.getRacketLine();
    const hitDistance = distancePointToSegment(
      this.shuttle.position,
      racket.start,
      racket.end,
    );
    const threshold = racketConfig.hitRadius + shuttleConfig.radius;

    if (hitDistance > threshold) {
      return;
    }

    const humanIntent =
      this.mode === 'single' && player.side === 'right'
        ? null
        : this.getHumanIntent(player.side);
    const aiIntent =
      this.mode === 'single' && player.side === 'right'
        ? createAiIntent(player, this.players.left, this.shuttle, 0)
        : null;
    const intent = humanIntent ?? aiIntent ?? emptyIntent;
    const timing = 1 - Math.abs(player.activeProgress - 0.5) * 2;
    const center = 1 - clamp(hitDistance / threshold, 0, 1);
    const quality = clamp(0.18 + center * 0.56 + timing * 0.38, 0, 1);
    const shot = this.chooseShot(player, intent);
    const velocity = this.getShotVelocity(player, intent, shot, quality);

    player.swingHasHit = true;
    this.shuttle.lastTouchedBy = player.side;
    this.shuttle.vx = velocity.x;
    this.shuttle.vy = velocity.y;
    this.shuttle.x = racket.end.x + sideDirection(player.side) * 18;
    this.shuttle.y += Math.sign(this.shuttle.y - racket.end.y) * 3;
    this.rallyHits += 1;
    this.lastHitLabel = `${quality > 0.86 ? 'Perfect' : quality > 0.52 ? 'Good' : 'Edge'} ${shot}`;
    this.lastHitTimer = 0.72;
  }

  private chooseShot(player: Player, intent: PlayerIntent): ShotKind {
    if (
      player.swingType === 'power' &&
      !player.grounded &&
      this.shuttle.y < worldConfig.groundY - 130
    ) {
      return 'smash';
    }

    if (intent.aimVertical > 0) {
      return 'drop';
    }

    if (intent.aimVertical < 0 && intent.aimForward < 0) {
      return 'lift';
    }

    if (intent.aimVertical < 0) {
      return 'clear';
    }

    if (intent.aimForward > 0 || player.swingType === 'power') {
      return 'drive';
    }

    return 'neutral';
  }

  private getShotVelocity(
    player: Player,
    intent: PlayerIntent,
    shot: ShotKind,
    quality: number,
  ): { x: number; y: number } {
    const direction = sideDirection(player.side);
    const base = {
      clear: { x: 590, y: -675 },
      drive: { x: 870, y: -165 },
      drop: { x: 365, y: -105 },
      lift: { x: 525, y: -735 },
      smash: { x: 1060, y: 390 },
      neutral: { x: 700, y: -385 },
    } satisfies Record<ShotKind, { x: number; y: number }>;
    const qualityScale = 0.74 + quality * 0.38;
    const forwardBonus = intent.aimForward > 0 ? 32 : 0;
    const edgeTilt = quality < 0.34 ? Math.sin(this.rallyHits * 1.73) * 75 : 0;

    return {
      x:
        direction * (base[shot].x + forwardBonus) * qualityScale +
        player.vx * 0.16,
      y: base[shot].y * qualityScale + player.vy * 0.06 + edgeTilt,
    };
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

    this.shuttle.x =
      this.shuttle.x < worldConfig.netX
        ? netRect.x - shuttleConfig.radius
        : netRect.x + netRect.width + shuttleConfig.radius;
    this.shuttle.vx *= -0.28;
    this.shuttle.vy = Math.max(120, this.shuttle.vy * 0.55);
    this.shuttle.netCooldown = 0.15;
    this.lastHitLabel = 'Net';
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
        ? 'Single Player: A/D/W/F/G'
        : 'Local Versus: P1 A/D/W/F/G, P2 Arrows/K/L';
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
      player.ai.serveTimer = 0;
      player.ai.decisionTimer = 0;
      player.ai.targetX = player.homeX;
    }
  }

  private resetRally(server: Side): void {
    this.resetPlayers();
    this.rallyHits = 0;
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
    ctx.beginPath();
    ctx.moveTo(chest.x, chest.y + 20);
    ctx.lineTo(offHandX, chest.y + 48);
    ctx.moveTo(chest.x, chest.y + 20);
    ctx.lineTo(racket.start.x, racket.start.y);
    ctx.stroke();

    ctx.strokeStyle =
      player.swingPhase === 'active' ? '#38f7ff' : 'rgba(17,24,39,0.82)';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(racket.start.x, racket.start.y);
    ctx.lineTo(racket.end.x, racket.end.y);
    ctx.stroke();
    ctx.strokeStyle =
      player.swingPhase === 'active' ? '#ffffff' : 'rgba(15,23,42,0.9)';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.ellipse(racket.end.x, racket.end.y, 28, 42, 0.2 * player.facing, 0, Math.PI * 2);
    ctx.stroke();
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
      ctx.lineTo(this.shuttle.x - this.shuttle.vx * 0.08, this.shuttle.y - this.shuttle.vy * 0.08);
      ctx.stroke();
    }
  }

  private drawHud(ctx: CanvasRenderingContext2D): void {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(15,23,42,0.58)';
    ctx.fillRect(548, 24, 504, 92);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 54px Inter, sans-serif';
    ctx.fillText(`${this.score.left}   ${this.score.right}`, worldConfig.width / 2, 64);
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

    const isAttached = this.shuttle.state === 'attached' && this.phase === 'playing';
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
            ? 'Swing to serve'
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
    ctx.fillText('P1: A/D move, W jump, F swing, G power', worldConfig.width / 2, 632);
    ctx.fillText('P2: arrows move/jump, K swing, L power', worldConfig.width / 2, 672);
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
      ctx.arc(racket.end.x, racket.end.y, racketConfig.hitRadius, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.strokeStyle = '#38f7ff';
    ctx.beginPath();
    ctx.arc(this.shuttle.x, this.shuttle.y, shuttleConfig.radius, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = 'rgba(15,23,42,0.72)';
    ctx.fillRect(24, 24, 330, 120);
    ctx.fillStyle = '#ffffff';
    ctx.font = '500 20px Inter, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`Phase: ${this.phase}`, 44, 55);
    ctx.fillText(`Ball: ${Math.round(this.shuttle.vx)}, ${Math.round(this.shuttle.vy)}`, 44, 84);
    ctx.fillText(`State: ${this.shuttle.state}`, 44, 113);
    ctx.restore();
  }

  private isDown(code: string): boolean {
    return this.input.down.has(code);
  }

  private wasPressed(code: string): boolean {
    return this.input.pressed.has(code);
  }
}

const oppositeSide = (side: Side): Side => (side === 'left' ? 'right' : 'left');
