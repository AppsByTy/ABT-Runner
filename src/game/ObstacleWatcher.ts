import { CONFIG } from '../core/Config';
import { events } from '../core/EventBus';
import { makeAABB, overlapX, overlapZ, type AABB } from '../utils/math';
import type { ObstacleManager } from '../world/Obstacles';
import type { PlayerController } from './PlayerController';

const N = CONFIG.nearMiss;

/**
 * Classifies how the player gets past each obstacle, once, as it goes by:
 *
 * - arrival (front reaches the player): if we're not in its lane, a tight
 *   horizontal gap is a lateral near miss; having just left its lane is a dodge.
 * - departure (back passes the player): if we were in its lane and survived,
 *   we cleared it by jump/slide; a tight vertical clearance is a near miss.
 */
export class ObstacleWatcher {
  private readonly oBox = makeAABB();

  update(obstacles: ObstacleManager, distance: number, player: PlayerController, pBox: AABB): void {
    obstacles.forEach((o) => {
      if (o.passed || o.destroyed) return;
      obstacles.getCollider(o, distance, this.oBox);
      const ob = this.oBox;

      if (!o.arrived && overlapZ(pBox, ob)) {
        o.arrived = true;
        o.inLane = overlapX(pBox, ob);
        if (o.inLane) {
          const since = player.time - (o.cls === 'high' ? player.lastSlideAt : player.lastJumpAt);
          o.late = since < N.lateAction;
        } else if (!o.noScore) {
          const gap = pBox.minX > ob.maxX ? pBox.minX - ob.maxX : ob.minX - pBox.maxX;
          const x = pBox.minX > ob.maxX ? ob.maxX : ob.minX;
          const y = Math.min(ob.maxY, 1.2);
          const left = player.time - player.laneLeftAt[o.lane];
          if (gap < N.lateralGap || left < N.lateDodge) {
            o.noScore = true;
            events.emit('nearMiss', { kind: o.kind, style: 'lateral', x, y, z: 0 });
          } else if (left < N.dodgeWindow) {
            o.noScore = true;
            events.emit('obstacleCleared', { kind: o.kind, how: 'dodge', x: o.x, y, z: 0 });
          }
        }
      }

      if (o.arrived && o.inLane && overlapZ(pBox, ob)) {
        const clear = o.cls === 'high' ? ob.minY - pBox.maxY : pBox.minY - ob.maxY;
        if (clear < o.minClear) o.minClear = clear;
      }

      if (!o.passed && ob.minZ > pBox.maxZ) {
        o.passed = true;
        if (o.inLane && !o.noScore && o.cls !== 'wall') {
          const x = o.x;
          const y = o.cls === 'high' ? ob.minY : ob.maxY;
          if (o.late || o.minClear < N.verticalClearance) {
            events.emit('nearMiss', { kind: o.kind, style: 'vertical', x, y, z: 0 });
          } else {
            events.emit('obstacleCleared', { kind: o.kind, how: o.cls === 'low' ? 'jump' : 'slide', x, y, z: 0 });
          }
        }
      }
    });
  }
}
