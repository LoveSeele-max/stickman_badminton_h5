import './style.css';
import { BadmintonGame } from './game/badminton-game';
import { CanvasRuntime } from './game/canvas-runtime';
import { InputSystem } from './game/input-system';
import type { AiDifficulty, MatchMode } from './game/types';

const canvas = document.querySelector<HTMLCanvasElement>('#game');

if (!canvas) {
  throw new Error('Game canvas was not found.');
}

const input = new InputSystem(canvas);
const params = new URLSearchParams(window.location.search);
const modeParam = params.get('mode');
const aiParam = params.get('ai');
const initialMode: MatchMode | undefined =
  modeParam === 'single' || modeParam === 'versus' ? modeParam : undefined;
const initialAiDifficulty: AiDifficulty =
  aiParam === 'boss' || aiParam === 'normal' ? aiParam : 'normal';
const game = new BadmintonGame(initialMode, initialAiDifficulty);
const runtime = new CanvasRuntime(canvas, game);

runtime.start(input);
