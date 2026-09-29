import { audio } from '../audio/AudioManager';
import type { LevelInfo, LifetimeStats } from '../core/Profile';
import type { ItemState, Shop, ShopTab } from '../game/Shop';

/**
 * Shop screen (a sheet over the menu, with the runner trying outfits on above
 * it) and the PROFILE screen.
 *
 * DOM is rebuilt only when something changes (tab, selection, purchase),
 * never per frame, and every animation is opacity/transform only.
 */
export interface ShopHooks {
  /** Show an outfit on the 3D runner (try-on); called with the equipped one on close. */
  previewOutfit(id: string): void;
  /** Shop opened/closed; `band` = free screen area for the runner (top, bottom as fractions of the height). */
  opened(open: boolean, band: [number, number]): void;
  /** Something was bought or equipped (menu, bank, cosmetics). */
  changed(): void;
}

const TABS: [ShopTab, string][] = [
  ['outfit', 'OUTFITS'],
  ['trail', 'TRAILS'],
  ['upgrade', 'UPGRADES'],
  ['boost', 'BOOSTS'],
];

const fmt = (n: number): string => Math.floor(n).toLocaleString('en-US');
const COIN = '<i class="ci"></i>';
const LOCK = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>';
const BACK = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';

/** Small icons for upgrades and boosts. */
const ICONS: Record<string, string> = {
  debug: '<path d="M8 9h8v7a4 4 0 0 1-8 0zM9 9a3 3 0 0 1 6 0M4 12h4M16 12h4M5 7l3 2M19 7l-3 2M5 18l3-2M19 18l-3-2"/>',
  boost: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4zM6 8h4M14 8h4"/>',
  ram: '<path d="M4 8h16v8H4zM7 8v8M11 8v8M15 8v8M6 16v3M18 16v3"/>',
  firewall: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  headstart: '<path d="M5 17l7-7 7 7M5 11l7-7 7 7"/>',
  double: '<path d="M4 7l6 10M10 7l-6 10M14 9a3 3 0 0 1 6 0c0 3-6 5-6 8h6"/>',
  backup: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
};
const icon = (id: string): string =>
  `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[id] ?? ''}</svg>`;

function swatch(it: ItemState): string {
  if (it.kind === 'outfit') return `<i class="sw-outfit" style="--a:${it.colors[0]};--b:${it.colors[1]}"><b></b></i>`;
  if (it.kind === 'trail') return `<i class="sw-trail${it.rainbow ? ' rgb' : ''}" style="--a:${it.colors[0]}"></i>`;
  return `<i class="sw-icon" style="--a:${it.colors[0]}">${icon(it.id)}</i>`;
}

export class ShopUI {
  readonly el: HTMLElement;
  private readonly shop: Shop;
  private readonly hooks: ShopHooks;
  private tab: ShopTab = 'outfit';
  private selected: Partial<Record<ShopTab, string>> = {};
  /** Two-tap buying: first tap arms the button, second tap buys. */
  private confirm: string | null = null;
  private confirmTimer = 0;
  private openState = false;

  constructor(parent: HTMLElement, shop: Shop, hooks: ShopHooks) {
    this.shop = shop;
    this.hooks = hooks;
    this.el = document.createElement('div');
    this.el.className = 'shop';
    this.el.id = 'p-shop';
    this.el.setAttribute('data-ui', '');
    this.el.innerHTML = `
      <div class="shop-top">
        <button class="icon-btn" id="sh-back" data-ui aria-label="Back">${BACK}</button>
        <div class="shop-title"><b>SHOP</b><span class="shop-cap" id="sh-cap">TRYING ON <em id="sh-capname"></em></span></div>
        <div class="shop-bank"><span class="coin-ico">A</span><b id="sh-bank">0</b></div>
      </div>
      <div class="shop-sheet">
        <div class="shop-tabs">${TABS.map(([t, l]) => `<button class="stab" data-tab="${t}" data-ui>${l}</button>`).join('')}</div>
        <div class="shop-grid" id="sh-grid"></div>
      </div>`;
    parent.appendChild(this.el);
    this.el.querySelector('#sh-back')!.addEventListener('click', () => this.close());
    this.el.querySelector('.shop-tabs')!.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
      if (!b || b.dataset.tab === this.tab) return;
      this.tab = b.dataset.tab as ShopTab;
      this.confirm = null;
      // The try-on only shows on the OUTFITS tab.
      this.hooks.previewOutfit(this.tab === 'outfit' ? (this.selected.outfit ?? this.shop.outfit().id) : this.shop.outfit().id);
      audio.play('ui');
      this.render(true);
    });
    this.el.querySelector('#sh-grid')!.addEventListener('click', (e) => this.onGrid(e));
    // Touches inside the shop never reach the game (no accidental run start),
    // and touchmove is kept from the game's scroll blocker so the list scrolls.
    for (const ev of ['pointerdown', 'touchstart', 'touchmove'] as const) this.el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  }

  get isOpen(): boolean {
    return this.openState;
  }

  open(tab: ShopTab = this.tab): void {
    this.tab = tab;
    this.confirm = null;
    this.selected = { outfit: this.shop.outfit().id, trail: this.shop.trail().id };
    this.openState = true;
    this.el.classList.add('show');
    this.el.parentElement!.classList.add('shop-open');
    this.hooks.opened(true, this.band());
    this.render(true);
    audio.play('ui');
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.el.classList.remove('show');
    this.el.parentElement!.classList.remove('shop-open');
    this.hooks.previewOutfit(this.shop.outfit().id);
    this.hooks.opened(false, this.band());
    window.clearTimeout(this.confirmTimer);
    audio.play('ui');
  }

  /** Screen area between the header and the sheet (layout positions, ignoring the slide-in transform). */
  band(): [number, number] {
    const h = window.innerHeight || 1;
    const top = this.el.querySelector<HTMLElement>('.shop-top')!;
    const sheet = this.el.querySelector<HTMLElement>('.shop-sheet')!;
    const t = (top.offsetTop + top.offsetHeight) / h + 0.015;
    const b = sheet.offsetTop / h - 0.015;
    return b - t > 0.15 ? [t, b] : [0.08, 0.42];
  }

  private onGrid(e: Event): void {
    const tile = (e.target as HTMLElement).closest<HTMLElement>('.it');
    if (!tile) return;
    const id = tile.dataset.id!;
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.it-btn');
    if (btn && !btn.disabled) {
      this.act(id, btn.dataset.act as 'buy' | 'equip');
      return;
    }
    // Tapping a tile selects it (outfits: try it on).
    if (this.selected[this.tab] === id) return;
    this.selected[this.tab] = id;
    if (this.tab === 'outfit') this.hooks.previewOutfit(id);
    audio.play('ui');
    this.render();
  }

  private act(id: string, act: 'buy' | 'equip'): void {
    const kind = this.tab;
    this.selected[kind] = id;
    if (act === 'equip' && (kind === 'outfit' || kind === 'trail')) {
      this.shop.equip(kind, id);
      if (kind === 'outfit') this.hooks.previewOutfit(id);
      this.hooks.changed();
      audio.play('ui');
      this.render();
      return;
    }
    const key = `${kind}:${id}`;
    if (this.confirm !== key) {
      this.confirm = key;
      window.clearTimeout(this.confirmTimer);
      this.confirmTimer = window.setTimeout(() => {
        this.confirm = null;
        if (this.openState) this.render();
      }, 3000);
      if (kind === 'outfit') this.hooks.previewOutfit(id);
      audio.play('ui');
      this.render();
      return;
    }
    this.confirm = null;
    window.clearTimeout(this.confirmTimer);
    const r = this.shop.buy(kind, id);
    if (r.ok) {
      audio.play('achievement');
      if (kind === 'outfit') this.hooks.previewOutfit(id);
      this.hooks.changed();
    }
    this.render();
    if (r.ok) {
      const tile = this.el.querySelector<HTMLElement>(`.it[data-id="${id}"]`);
      tile?.classList.add('bought');
    }
  }

  private render(tabChanged = false): void {
    this.el.querySelector('#sh-bank')!.textContent = fmt(this.shop.bank);
    this.el.querySelectorAll<HTMLElement>('.stab').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    const items = this.shop.items(this.tab);
    const sel = this.selected[this.tab];
    const grid = this.el.querySelector<HTMLElement>('#sh-grid')!;
    grid.dataset.tab = this.tab;
    grid.innerHTML = items.map((it) => this.tile(it, it.id === sel)).join('');
    if (tabChanged) grid.scrollTop = 0;
    const cap = this.el.querySelector<HTMLElement>('#sh-cap')!;
    const outfit = this.tab === 'outfit' ? items.find((x) => x.id === sel) : undefined;
    cap.classList.toggle('show', !!outfit && !outfit.equipped);
    if (outfit) this.el.querySelector('#sh-capname')!.textContent = outfit.name;
  }

  private tile(it: ItemState, sel: boolean): string {
    const key = `${it.kind}:${it.id}`;
    let extra = '';
    if (it.kind === 'upgrade') extra = `<span class="pips">${'<i class="on"></i>'.repeat(it.count)}${'<i></i>'.repeat(it.max - it.count)}</span>`;
    if (it.kind === 'boost') extra = `<span class="stock">${it.count ? `×${it.count} IN STOCK${it.armed ? ' · ON' : ''}` : 'NONE YET'}</span>`;
    let btn: string;
    if (it.lockLevel) btn = `<button class="it-btn locked" disabled>${LOCK} LV ${it.lockLevel}</button>`;
    else if ((it.kind === 'outfit' || it.kind === 'trail') && it.equipped) btn = '<button class="it-btn equipped" disabled>EQUIPPED</button>';
    else if ((it.kind === 'outfit' || it.kind === 'trail') && it.owned) btn = '<button class="it-btn equip" data-act="equip" data-ui>EQUIP</button>';
    else if (it.price <= 0) btn = '<button class="it-btn equipped" disabled>MAXED</button>';
    else if (this.confirm === key && it.affordable) btn = `<button class="it-btn confirm" data-act="buy" data-ui>CONFIRM ${COIN}${fmt(it.price)}</button>`;
    else {
      const verb = it.kind === 'upgrade' ? (it.count ? 'UPGRADE ' : 'UNLOCK ') : it.kind === 'boost' ? 'BUY ' : '';
      btn = `<button class="it-btn buy${it.affordable ? '' : ' poor'}" data-act="buy" data-ui${it.affordable ? '' : ' disabled'}>${verb}${COIN}${fmt(it.price)}</button>`;
    }
    const cls = ['it', `k-${it.kind}`, sel ? 'sel' : '', it.equipped ? 'equipped' : '', it.lockLevel ? 'locked' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-id="${it.id}"><div class="it-sw">${swatch(it)}</div><div class="it-info"><b class="it-name">${it.name}</b><span class="it-desc">${it.desc}</span>${extra}</div>${btn}</div>`;
  }
}

export interface ProfileStats {
  level: LevelInfo;
  bank: number;
  mult: number;
  best: number;
  set: number;
  stats: LifetimeStats;
}

/** PROFILE: level, rank, multiplier and lifetime stats. */
export class ProfileScreen {
  readonly el: HTMLElement;
  private openState = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'panel profile';
    this.el.id = 'p-profile';
    this.el.setAttribute('data-ui', '');
    parent.appendChild(this.el);
    this.el.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('#pf-done')) this.close();
    });
    for (const ev of ['pointerdown', 'touchstart', 'touchmove'] as const) this.el.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  }

  get isOpen(): boolean {
    return this.openState;
  }

  open(v: ProfileStats): void {
    const s = v.stats;
    const mins = Math.round(s.time / 60);
    const rows: [string, string][] = [
      ['HIGH SCORE', fmt(v.best)],
      ['BEST RUN', `${fmt(s.bestDistance)} m`],
      ['RUNS', fmt(s.runs)],
      ['DISTANCE', `${(s.distance / 1000).toFixed(1)} km`],
      ['BUGS FIXED', fmt(s.bugsFixed)],
      ['VIRUSES DELETED', fmt(s.bossesDeleted)],
      ['MISSIONS DONE', fmt(s.missionsDone)],
      ['TIME PLAYED', mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} m` : `${mins} min`],
      ['COINS COLLECTED', fmt(s.coins)],
      ['COINS SPENT', fmt(s.coinsSpent)],
    ];
    const l = v.level;
    this.el.innerHTML = `
      <div class="pf-head">
        <div class="lvl-badge"><small>LV</small><b>${l.level}</b></div>
        <div class="pf-mid">
          <div class="pf-rank">${l.rank}</div>
          <div class="xpbar"><i style="transform:scaleX(${l.frac.toFixed(3)})"></i></div>
          <div class="pf-xp">${fmt(l.into)} / ${fmt(l.need)} XP to level ${l.level + 1}</div>
        </div>
      </div>
      <div class="pf-chips">
        <div><span>SCORE MULTIPLIER</span><b>×${v.mult}</b></div>
        <div><span>COIN BANK</span><b><span class="coin-ico">A</span>${fmt(v.bank)}</b></div>
        <div><span>MISSION SETS</span><b>${fmt(v.set)}</b></div>
      </div>
      <div class="pf-stats">${rows.map(([k, val]) => `<div><span>${k}</span><b>${val}</b></div>`).join('')}</div>
      <button class="btn primary" id="pf-done" data-ui>DONE</button>`;
    this.openState = true;
    this.el.classList.add('show');
    this.el.parentElement!.classList.add('profile-open');
    audio.play('ui');
  }

  close(): void {
    if (!this.openState) return;
    this.openState = false;
    this.el.classList.remove('show');
    this.el.parentElement!.classList.remove('profile-open');
    audio.play('ui');
  }
}
