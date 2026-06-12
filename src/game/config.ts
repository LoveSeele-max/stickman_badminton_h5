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
  length: 118,
  hitRadius: 48,
  windup: 0.045,
  active: 0.16,
  recovery: 0.16,
};

export const shuttleConfig = {
  radius: 15,
  gravity: 1000,
  linearDrag: 0.22,
  quadraticDrag: 0.00038,
  maxSpeed: 1450,
};

export const matchConfig = {
  targetScore: 7,
  pointPause: 1.15,
};

export const aiConfig = {
  reactionInterval: 0.12,
  targetError: 34,
  serveDelay: 0.85,
};
