import { aiConfig, shuttleConfig, worldConfig } from './config';
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
      hitPressed: player.ai.serveTimer > aiConfig.serveDelay,
      pausePressed: emptyPause,
    };
  }

  player.ai.serveTimer = 0;

  if (player.ai.decisionTimer <= 0) {
    const prediction = predictTarget(player.side, shuttle);
    const pressure = opponent.side === 'left' ? opponent.x < 500 : opponent.x > 1100;

    player.ai.targetX = clamp(
      prediction.targetX + prediction.error,
      player.minX,
      player.maxX,
    );

    if (pressure && prediction.isThreat) {
      player.ai.targetX += sideDirection(player.side) * 18;
    }

    player.ai.decisionTimer = aiConfig.reactionInterval;
  }

  const dx = player.ai.targetX - player.x;
  const move = Math.abs(dx) < 18 ? 0 : Math.sign(dx);
  const racket = player.getRacketLine();
  const racketX = (racket.start.x + racket.end.x) / 2;
  const racketY = (racket.start.y + racket.end.y) / 2;
  const distanceToRacket = Math.hypot(shuttle.x - racketX, shuttle.y - racketY);
  const ballOnOwnSide = isOnSide(shuttle.x, player.side);
  const incoming = sideDirection(player.side) * shuttle.vx < 80 || ballOnOwnSide;
  const shouldJump =
    ballOnOwnSide &&
    incoming &&
    Math.abs(dx) < 95 &&
    shuttle.y < worldConfig.groundY - 205 &&
    shuttle.vy > -620;
  const shouldSwing =
    shuttle.state === 'flying' &&
    incoming &&
    distanceToRacket < 128 &&
    shuttle.y < worldConfig.groundY - 32;

  return {
    move,
    jump: shouldJump,
    jumpPressed: shouldJump && player.grounded,
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
  let bestX = side === 'left' ? 360 : 1240;
  let bestY = worldConfig.groundY;
  let sawOwnSide = false;
  const step = 1 / 60;

  for (let i = 0; i < 210; i += 1) {
    const speed = Math.hypot(vx, vy);
    const drag =
      1 - Math.min(0.82, (shuttleConfig.linearDrag + shuttleConfig.quadraticDrag * speed) * step);
    vx *= drag;
    vy = vy * drag + shuttleConfig.gravity * step;
    x += vx * step;
    y += vy * step;

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
