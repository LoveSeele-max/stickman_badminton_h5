import { aiConfig, racketConfig, worldConfig } from './config';
import { stepFlightStateMutable, type FlightState } from './flight';
import { clamp, sideDirection } from './math';
import type { Player, Shuttlecock } from './entities';
import type { AiDifficulty, PlayerIntent, Side } from './types';

const emptyPause = false;

export const createAiIntent = (
  player: Player,
  opponent: Player,
  shuttle: Shuttlecock,
  dt: number,
  difficulty: AiDifficulty = 'normal',
): PlayerIntent => {
  const tuning = aiConfig[difficulty];

  player.ai.decisionTimer -= dt;

  if (shuttle.state === 'attached' && shuttle.attachedTo === player.side) {
    player.ai.serveTimer += dt;
    return {
      move: 0,
      jump: false,
      jumpPressed: false,
      hitHeld: false,
      hitPressed:
        player.ai.serveTimer > tuning.serveDelay &&
        !player.isSwinging &&
        player.queuedHitTimer <= 0,
      pausePressed: emptyPause,
    };
  }

  player.ai.serveTimer = 0;

  if (player.ai.decisionTimer <= 0) {
    const prediction = predictTarget(
      player.side,
      shuttle,
      tuning.targetError,
      tuning.predictionStep,
      tuning.predictionFrames,
      tuning.interceptHeight,
    );
    const pressure =
      opponent.side === 'left'
        ? opponent.x < tuning.pressureLine
        : opponent.x > worldConfig.width - tuning.pressureLine;
    const direction = sideDirection(player.side);
    const racketOffset = direction * tuning.racketOffset;
    const read = Math.sin(
      shuttle.x * 0.027 +
        shuttle.y * 0.019 +
        shuttle.vx * 0.004 +
        player.x * 0.013,
    );
    const misread = prediction.isThreat && read > tuning.misreadThreshold;
    const mistake = misread ? direction * tuning.mistakeOffset : 0;

    player.ai.targetX = clamp(
      prediction.targetX - racketOffset + prediction.error + mistake,
      player.minX,
      player.maxX,
    );

    if (pressure && prediction.isThreat) {
      player.ai.targetX += direction * tuning.pressureStep;
    }

    if (difficulty === 'boss' && prediction.highBall && prediction.isThreat) {
      player.ai.targetX += direction * 18;
    }

    player.ai.targetX = clamp(player.ai.targetX, player.minX, player.maxX);
    player.ai.decisionTimer = tuning.reactionInterval;
  }

  const dx = player.ai.targetX - player.x;
  const move = Math.abs(dx) < tuning.stopDistance ? 0 : Math.sign(dx);
  const racket = player.getRacketLine();
  const racketX = (racket.start.x + racket.end.x) / 2;
  const racketY = (racket.start.y + racket.end.y) / 2;
  const distanceToRacket = Math.hypot(shuttle.x - racketX, shuttle.y - racketY);
  const direction = sideDirection(player.side);
  const forward = direction * (shuttle.x - player.x);
  const height = player.y - shuttle.y;
  const inHitZone =
    forward >= racketConfig.assistForwardMin - 2 &&
    forward <= racketConfig.assistForwardMax + tuning.assistForwardPad &&
    height >= racketConfig.assistHeightMin &&
    height <= racketConfig.assistHeightMax + tuning.assistHeightPad;
  const ballOnOwnSide = isOnSide(shuttle.x, player.side);
  const incoming = direction * shuttle.vx < 70 || ballOnOwnSide;
  const bossAttackJump =
    difficulty === 'boss' &&
    ballOnOwnSide &&
    incoming &&
    Math.abs(dx) < tuning.jumpDx &&
    height > tuning.jumpMinHeight &&
    shuttle.vy > tuning.jumpVyMin &&
    (forward > 12 || height > 260);
  const shouldJump =
    bossAttackJump ||
    (ballOnOwnSide &&
      incoming &&
      Math.abs(dx) < tuning.jumpDx &&
      height > tuning.jumpMinHeight &&
      shuttle.vy > tuning.jumpVyMin);
  const timingRead = Math.sin(
    shuttle.x * 0.019 +
      shuttle.y * 0.023 +
      shuttle.vx * 0.003 +
      player.x * 0.011,
  );
  const mistimed =
    timingRead > tuning.timingMistakeThreshold &&
    height < tuning.timingMistakeMaxHeight;
  const shouldSwing =
    shuttle.state === 'flying' &&
    incoming &&
    !mistimed &&
    (distanceToRacket < tuning.hitDistance || inHitZone) &&
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
  targetError: number,
  step: number,
  maxFrames: number,
  interceptHeight: number,
): { targetX: number; error: number; highBall: boolean; isThreat: boolean } => {
  if (shuttle.state !== 'flying') {
    return {
      targetX: side === 'left' ? 360 : 1240,
      error: 0,
      highBall: false,
      isThreat: false,
    };
  }

  const state: FlightState = {
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
  for (let i = 0; i < maxFrames; i += 1) {
    stepFlightStateMutable(state, step);

    if (isOnSide(state.x, side)) {
      sawOwnSide = true;
      bestX = state.x;
      bestY = state.y;

      if (state.y > worldConfig.groundY - interceptHeight) {
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
    targetError;

  return {
    targetX: sawOwnSide ? bestX : side === 'left' ? 385 : 1215,
    error: stableNoise,
    highBall: bestY < worldConfig.groundY - 185,
    isThreat: Math.abs(bestX - worldConfig.netX) > 160,
  };
};

const isOnSide = (x: number, side: Side): boolean =>
  side === 'left' ? x < worldConfig.netX : x > worldConfig.netX;
