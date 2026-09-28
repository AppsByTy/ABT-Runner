import './style.css';
import './ui/premium.css';
import { GameManager } from './core/GameManager';
import { events } from './core/EventBus';
import { audio } from './audio/AudioManager';

const container = document.getElementById('app')!;
const game = new GameManager(container);
game.run();

// Test/debug handle (dev builds only).
if (import.meta.env.DEV) {
  Object.assign(window, { __game: game, __events: events, __audio: audio });
}
