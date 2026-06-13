import { aiConfig, racketConfig, shuttleConfig, worldConfig } from './config';
import { clamp, sideDirection } from './math';
import type { Player, Shuttlecock } from './entities';
import type { PlayerIntent, Side } from './types';

const emptyPause = false;

export const createAiIntent = (
  player: Player,
  opponent: Player,
  shuttle: Shuttlecock,
  dt: number,
): PlayerIntent => {
  player.ai.decisionTimer -= dt;

  if (shuttle.state === 'attached' && shuttle.attachedTo === player.side) {
    player.ai.serveTimer += dt;
    return {
      move: 0,
      jump: false,
      jumpPressed: false,
      hitHeld: false,
      hitPressed: player.ai.serveTimer > aiConfig.serveDelay,
      pausePressed: emptyPause,
    };
  }

  player.ai.serveTimer = 0;

  if (player.ai.decisionTimer <= 0) {
    const prediction = predictTarget(player.side, shuttle);
    const pressure = opponent.side === 'left' ? opponent.x < 500 : opponent.x > 1100;
    const direction = sideDirection(player.side);
    const racketOffset = direction * 96;
    const read = Math.sin(
      shuttle.x * 0.027 +
        shuttle.y * 0.019 +
        shuttle.vx * 0.004 +
        player.x * 0.013,
    );
    const misread = prediction.isThreat && read > 0.76;
    const mistake = misread ? direction * 118 : 0;

    player.ai.targetX = clamp(
      prediction.targetX - racketOffset + prediction.error + mistake,
      player.minX,
      player.maxX,
    );

    if (pressure && prediction.isThreat) {
      player.ai.targetX += direction * 12;
    }

    player.ai.decisionTimer = aiConfig.reactionInterval;
  }

  const dx = player.ai.targetX - player.x;
  const move = Math.abs(dx) < 18 ? 0 : Math.sign(dx);
  const racket = player.getRacketLine();
  const racketX = (racket.start.x + racket.end.x) / 2;
  const racketY = (racket.start.y + racket.end.y) / 2;
  const distanceToRacket = Math.hypot(shuttle.x - racketX, shuttle.y - racketY);
  const direction = sideDirection(player.side);
  const forward = direction * (shuttle.x - player.x);
  const height = player.y - shuttle.y;
  const inHitZone =
    forward >= racketConfig.assistForwardMin - 2 &&
    forward <= racketConfig.assistForwardMax + 6 &&
    height >= racketConfig.assistHeightMin &&
    height <= racketConfig.assistHeightMax + 4;
  const ballOnOwnSide = isOnSide(shuttle.x, player.side);
  const incoming = direction * shuttle.vx < 70 || ballOnOwnSide;
  const shouldJump =
    ballOnOwnSide &&
    incoming &&
    Math.abs(dx) < 118 &&
    height > 230 &&
    shuttle.vy > -650;
  const timingRead = Math.sin(
    shuttle.x * 0.019 +
      shuttle.y * 0.023 +
      shuttle.vx * 0.003 +
      player.x * 0.011,
  );
  const mistimed = timingRead > 0.9 && height < 210;
  const shouldSwing =
    shuttle.state === 'flying' &&
    incoming &&
    !mistimed &&
    (distanceToRacket < 132 || inHitZone) &&
    height > 34;

  return {
    move,
    jump: shouldJump,
    jumpPressed: shouldJump && player.grounded,
    hitHeld: false,
    hitPressed: shouldSwing,
    pausePressed: emptyPause,
  };
};

const predictTarget = (
  side: Side,
  shuttle: Shuttlecock,
): { targetX: number; error: number; highBall: boolean; isThreat: boolean } => {
  if (shuttle.state !== 'flying') {
    return {
      targetX: side === 'left' ? 360 : 1240,
      error: 0,
      highBall: false,
      isThreat: false,
    };
  }

  let x = shuttle.x;
  let y = shuttle.y;
  let vx = shuttle.vx;
  let vy = shuttle.vy;
  let dragGraceTimer = shuttle.dragGraceTimer;
  let flightTimer = shuttle.flightTimer;
  const flightProfile = shuttle.flightProfile;
  let bestX = side === 'left' ? 360 : 1240;
  let bestY = worldConfig.groundY;
  let sawOwnSide = false;
  const step = 1 / 90;

  for (let i = 0; i < 330; i += 1) {
    const graceDuration =
      flightProfile === 'serve'
        ? shuttleConfig.serveDragGrace
        : shuttleConfig.postHitDragGrace;
    const lateHorizontalScale =
      flightProfile === 'serve'
        ? shuttleConfig.serveLateHorizontalDragScale
        : shuttleConfig.lateHorizontalDragScale;
    const lateStart = flightProfile === 'serve' ? 0.5 : 0.24;
    const lateDuration = flightProfile === 'serve' ? 0.82 : 0.48;
    const dragProgress = clamp(1 - dragGraceTimer / Math.max(graceDuration, 0.001), 0, 1);
    const smoothProgress = smoothstep(dragProgress);
    const lateProgress = smoothstep(clamp((flightTimer - lateStart) / lateDuration, 0, 1));
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
      vy > 0
        ? lerp(startDragScale, shuttleConfig.descentDragScale, lateProgress)
        : startDragScale;
    const horizontalDrag =
      1 -
      Math.min(
        0.82,
        (shuttleConfig.horizontalLinearDrag +
          shuttleConfig.horizontalQuadraticDrag * Math.abs(vx)) *
          horizontalDragScale *
          step,
      );
    const verticalDrag =
      1 -
      Math.min(
        0.72,
        (shuttleConfig.verticalLinearDrag +
          shuttleConfig.verticalQuadraticDrag * Math.abs(vy)) *
          verticalDragScale *
          step,
      );
    vx *= horizontalDrag;
    vy = Math.min(
      vy * verticalDrag + shuttleConfig.gravity * step,
      shuttleConfig.maxFallSpeed,
    );
    const clampedSpeed = Math.hypot(vx, vy);

    if (clampedSpeed > shuttleConfig.maxSpeed) {
      const scale = shuttleConfig.maxSpeed / clampedSpeed;
      vx *= scale;
      vy *= scale;
    }

    x += vx * step;
    y += vy * step;
    dragGraceTimer = Math.max(0, dragGraceTimer - step);
    flightTimer += step;

    if (isOnSide(x, side)) {
      sawOwnSide = true;
      bestX = x;
      bestY = y;

      if (y > worldConfig.groundY - 245) {
        break;
      }
    }

    if (y >= worldConfig.groundY) {
      bestX = x;
      bestY = worldConfig.groundY;
      break;
    }
  }

  const sideSign = sideDirection(side);
  const stableNoise =
    Math.sin((shuttle.x * 0.017 + shuttle.y * 0.031 + shuttle.vx * 0.011) * sideSign) *
    aiConfig.targetError;

  return {
    targetX: sawOwnSide ? bestX : side === 'left' ? 385 : 1215,
    error: stableNoise,
    highBall: bestY < worldConfig.groundY - 185,
    isThreat: Math.abs(bestX - worldConfig.netX) > 160,
  };
};

const isOnSide = (x: number, side: Side): boolean =>
  side === 'left' ? x < worldConfig.netX : x > worldConfig.netX;

const lerp = (from: number, to: number, t: number): number =>
  from + (to - from) * t;

const smoothstep = (value: number): number => {
  const t = clamp(value, 0, 1);

  return t * t * (3 - 2 * t);
};
