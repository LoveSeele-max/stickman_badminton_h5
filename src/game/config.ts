export const worldConfig = {
  width: 1600,
  height: 900,
  groundY: 780,
  netX: 800,
  netWidth: 18,
  netHeight: 245,
  sidePadding: 54,
};

export const playerConfig = {
  height: 170,
  radius: 38,
  maxSpeed: 450,
  acceleration: 3100,
  groundFriction: 20,
  airControl: 0.46,
  jumpSpeed: 745,
  gravity: 1950,
  coyoteTime: 0.08,
  jumpBuffer: 0.14,
};

export const racketConfig = {
  length: 126,
  hitRadius: 58,
  windup: 0,
  active: 0.23,
  recovery: 0.1,
  hitBuffer: 0.16,
  assistForwardMin: -28,
  assistForwardMax: 244,
  assistHeightMin: 34,
  assistHeightMax: 318,
};

export const shuttleConfig = {
  radius: 15,
  gravity: 1040,
  linearDrag: 0.18,
  quadraticDrag: 0.00031,
  maxSpeed: 1800,
};

export const matchConfig = {
  targetScore: 7,
  pointPause: 1.15,
};

export const aiConfig = {
  reactionInterval: 0.065,
  targetError: 12,
  serveDelay: 0.52,
};
