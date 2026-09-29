import './style.css';
import './ui/premium.css';
import './ui/progression.css';
import './ui/shop.css';
import { GameManager } from './core/GameManager';
import { events } from './core/EventBus';
import { audio } from './audio/AudioManager';
import { attachStress, startupVariant, variantSpec } from './dev/stress';
import { OUTFIT } from './game/ModelAvatar';
import { TRAIL_STYLE } from './fx/Trails';

const container = document.getElementById('app')!;
// On-device crash test harness: only in builds made with VITE_STRESS=1.
const variant = import.meta.env.VITE_STRESS ? startupVariant() : null;
const spec = variantSpec(variant);
if (spec && !spec.audio) {
  // No audio at all: the game finds no Web Audio support and stays silent.
  Object.assign(window, { AudioContext: undefined, webkitAudioContext: undefined });
}
const game = new GameManager(container, { avatar: spec?.avatar ?? true });
game.run();
if (import.meta.env.VITE_STRESS) attachStress(game, variant);

// Test/debug handle (dev builds only).
if (import.meta.env.DEV) {
  Object.assign(window, { __game: game, __events: events, __audio: audio, __outfit: OUTFIT, __trail: TRAIL_STYLE });
}
