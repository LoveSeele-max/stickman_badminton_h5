import './style.css';
import { BadmintonGame } from './game/badminton-game';
import { CanvasRuntime } from './game/canvas-runtime';
import { InputSystem } from './game/input-system';
import type { MatchMode } from './game/types';

const canvas = document.querySelector<HTMLCanvasElement>('#game');

if (!canvas) {
  throw new Error('Game canvas was not found.');
}

const input = new InputSystem(canvas);
const modeParam = new URLSearchParams(window.location.search).get('mode');
const initialMode: MatchMode | undefined =
  modeParam === 'single' || modeParam === 'versus' ? modeParam : undefined;
const game = new BadmintonGame(initialMode);
const runtime = new CanvasRuntime(canvas, game);

runtime.start(input);
