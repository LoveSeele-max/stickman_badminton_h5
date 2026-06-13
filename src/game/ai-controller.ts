import { aiConfig, racketConfig, worldConfig } from './config';
import { stepFlightState, type FlightState } from './flight';
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
      hitPressed:
        player.ai.serveTimer > aiConfig.serveDelay &&
        !player.isSwinging &&
        player.queuedHitTimer <= 0,
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

  let state: FlightState = {
    dragGraceTimer: shuttle.dragGraceTimer,
    flightProfile: shuttle.flightProfile,
    flightTimer: shuttle.flightTimer,
    vx: shuttle.vx,
    vy: shuttle.vy,
    x: shuttle.x,
    y: shuttle.y,
  };
  let bestX = side === 'left' ? 360 : 1240;
  let bestY = worldConfig.groundY;
  let sawOwnSide = false;
  const step = 1 / 90;

  for (let i = 0; i < 330; i += 1) {
    state = stepFlightState(state, step);

    if (isOnSide(state.x, side)) {
      sawOwnSide = true;
      bestX = state.x;
      bestY = state.y;

      if (state.y > worldConfig.groundY - 245) {
        break;
      }
    }

    if (state.y >= worldConfig.groundY) {
      bestX = state.x;
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
