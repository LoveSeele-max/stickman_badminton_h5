export type Side = 'left' | 'right';

export type MatchMode = 'single' | 'versus';

export type GamePhase = 'menu' | 'playing' | 'paused' | 'point' | 'matchEnd';

export type ShuttleState = 'attached' | 'flying' | 'grounded' | 'out';

export type SwingType = 'normal' | 'power';

export type ShotKind = 'clear' | 'drive' | 'drop' | 'lift' | 'smash' | 'neutral';

export interface Vec2 {
  x: number;
  y: number;
}

export interface InputSnapshot {
  down: ReadonlySet<string>;
  pressed: ReadonlySet<string>;
}

export interface PlayerIntent {
  move: number;
  aimForward: number;
  aimVertical: number;
  jump: boolean;
  jumpPressed: boolean;
  swingPressed: boolean;
  powerPressed: boolean;
  pausePressed: boolean;
}

export interface Viewport {
  width: number;
  height: number;
  scale: number;
  offsetX: number;
  offsetY: number;
  dpr: number;
}

export interface AiMemory {
  serveTimer: number;
  decisionTimer: number;
  targetX: number;
  aimForward: number;
  aimVertical: number;
  wantsPower: boolean;
}
