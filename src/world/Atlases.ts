import * as THREE from 'three';
import { canvasTexture } from '../utils/textures';

// ---------------------------------------------------------- canvas assets

const MONO = '"SF Mono", "Cascadia Mono", Menlo, Consolas, "Courier New", monospace';

/** 4x4 grid of 512x256 holographic UI windows. Cells 12-15 are error windows. */
export function panelAtlas(): THREE.CanvasTexture {
  return canvasTexture(2048, 1024, (ctx) => {
    const CW = 512;
    const CH = 256;
    const cyan = '#7ff4ff';
    const lime = '#c6ff5a';
    const pink = '#ff6be6';
    const frame = (x: number, y: number, title: string, color: string): void => {
      ctx.fillStyle = 'rgba(10,30,50,0.55)';
      ctx.fillRect(x + 8, y + 8, CW - 16, CH - 16);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.85;
      ctx.fillRect(x + 8, y + 8, CW - 16, 30);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 9.5, y + 9.5, CW - 19, CH - 19);
      ctx.fillStyle = '#021018';
      ctx.font = `700 18px ${MONO}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(title, x + 20, y + 24);
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(x + CW - 26 - i * 22, y + 23, 6, 0, Math.PI * 2);
        ctx.fillStyle = '#021018';
        ctx.fill();
      }
    };
    const lines = (x: number, y: number, rows: [string, string][], size = 17): void => {
      ctx.font = `600 ${size}px ${MONO}`;
      ctx.textBaseline = 'top';
      rows.forEach(([txt, color], i) => {
        ctx.fillStyle = color;
        ctx.fillText(txt, x, y + i * (size + 6));
      });
    };
    const cell = (i: number): [number, number] => [(i % 4) * CW, Math.floor(i / 4) * CH];

    // 0 Browser
    let [x, y] = cell(0);
    frame(x, y, 'appsbyty.com', cyan);
    ctx.fillStyle = 'rgba(127,244,255,0.25)';
    ctx.fillRect(x + 24, y + 52, CW - 48, 22);
    ctx.fillStyle = lime;
    ctx.fillRect(x + 24, y + 90, 180, 70);
    ctx.fillStyle = 'rgba(127,244,255,0.35)';
    for (let i = 0; i < 4; i++) ctx.fillRect(x + 224, y + 92 + i * 18, 240 - i * 30, 8);
    ctx.fillStyle = pink;
    ctx.fillRect(x + 24, y + 180, 120, 34);
    ctx.fillStyle = 'rgba(127,244,255,0.5)';
    ctx.fillRect(x + 160, y + 180, 120, 34);

    // 1 Terminal
    [x, y] = cell(1);
    frame(x, y, 'bash — ty@appsbyty', lime);
    lines(x + 22, y + 50, [
      ['$ npm run fix-bugs', lime],
      ['> scanning 1,024 modules...', cyan],
      ['> 3 bugs found', '#ffd23a'],
      ['> patching... ████████ 100%', cyan],
      ['✓ all systems nominal', lime],
      ['$ _', lime],
    ]);

    // 2 Code editor
    [x, y] = cell(2);
    frame(x, y, 'runner.ts', '#8a9cff');
    lines(x + 22, y + 50, [
      ['01  function run(dev) {', '#9fb3ff'],
      ['02    while (alive) {', pink],
      ['03      dodge(errors);', cyan],
      ['04      fix(bugs++);', lime],
      ['05      collect(code);', '#ffd23a'],
      ['06    }', pink],
      ['07  }', '#9fb3ff'],
    ], 16);

    // 3 Folder window
    [x, y] = cell(3);
    frame(x, y, '/src/apps', '#ffd23a');
    for (let i = 0; i < 4; i++) {
      const fx = x + 30 + i * 118;
      ctx.fillStyle = '#ffd23a';
      ctx.fillRect(fx, y + 70, 36, 12);
      ctx.fillRect(fx, y + 78, 84, 62);
      ctx.fillStyle = '#021018';
      ctx.font = `600 14px ${MONO}`;
      ctx.fillText(['api', 'ui', 'core', 'bugs'][i], fx + 4, y + 150);
    }

    // 4 App UI (AppsByTy)
    [x, y] = cell(4);
    frame(x, y, 'AppsByTy Builder', lime);
    ctx.fillStyle = lime;
    ctx.font = `900 64px system-ui, Arial, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText('A', x + 40, y + 130);
    lines(x + 130, y + 70, [
      ['BUILD  ▸  DEPLOY', cyan],
      ['apps live: 128', lime],
      ['uptime: 99.99%', cyan],
    ], 20);
    ctx.fillStyle = pink;
    ctx.fillRect(x + 130, y + 180, 160, 30);

    // 5 System monitor graph
    [x, y] = cell(5);
    frame(x, y, 'system monitor', cyan);
    ctx.strokeStyle = lime;
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const gx = x + 24 + i * 11.5;
      const gy = y + 150 - Math.abs(Math.sin(i * 0.55) * 50 + Math.sin(i * 1.7) * 20);
      if (i === 0) ctx.moveTo(gx, gy);
      else ctx.lineTo(gx, gy);
    }
    ctx.stroke();
    lines(x + 24, y + 180, [['CPU 42%   MEM 61%   NET ▲▼', cyan]]);

    // 6 Network map
    [x, y] = cell(6);
    frame(x, y, 'network', pink);
    const nodes: [number, number][] = [];
    for (let i = 0; i < 9; i++) nodes.push([x + 50 + ((i * 97) % 420), y + 70 + ((i * 53) % 150)]);
    ctx.strokeStyle = 'rgba(127,244,255,0.6)';
    ctx.lineWidth = 2;
    nodes.forEach((a, i) => {
      const b = nodes[(i + 3) % nodes.length];
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
    });
    for (const [nx, ny] of nodes) {
      ctx.fillStyle = pink;
      ctx.beginPath();
      ctx.arc(nx, ny, 9, 0, Math.PI * 2);
      ctx.fill();
    }

    // 7 Cloud storage
    [x, y] = cell(7);
    frame(x, y, 'cloud storage', cyan);
    ctx.fillStyle = cyan;
    const cloud = (cx: number, cy: number, s: number): void => {
      ctx.beginPath();
      ctx.arc(cx, cy, 30 * s, 0, Math.PI * 2);
      ctx.arc(cx + 34 * s, cy - 12 * s, 38 * s, 0, Math.PI * 2);
      ctx.arc(cx + 72 * s, cy, 30 * s, 0, Math.PI * 2);
      ctx.fill();
    };
    cloud(x + 70, y + 130, 1.1);
    lines(x + 240, y + 90, [['synced ✓', lime], ['2.4 TB free', cyan], ['backups: 7', cyan]], 20);

    // 8 Binary dump
    [x, y] = cell(8);
    frame(x, y, 'memory 0x7FF3', '#8a9cff');
    const rows: [string, string][] = [];
    let seed = 3;
    for (let r = 0; r < 7; r++) {
      let s = '';
      for (let k = 0; k < 28; k++) {
        seed = (seed * 16807) % 2147483647;
        s += seed % 2 ? '1' : '0';
        if (k % 8 === 7) s += ' ';
      }
      rows.push([s, r % 2 ? cyan : '#9fb3ff']);
    }
    lines(x + 22, y + 50, rows, 15);

    // 9 Download / progress
    [x, y] = cell(9);
    frame(x, y, 'updates', lime);
    lines(x + 24, y + 56, [['Installing patch v4.2.0', cyan]], 18);
    ctx.strokeStyle = cyan;
    ctx.strokeRect(x + 24.5, y + 110.5, CW - 49, 30);
    ctx.fillStyle = lime;
    ctx.fillRect(x + 28, y + 114, (CW - 56) * 0.72, 23);
    lines(x + 24, y + 160, [['72%  ·  eta 00:03', lime]], 18);

    // 10 Git log
    [x, y] = cell(10);
    frame(x, y, 'git log', pink);
    lines(x + 22, y + 50, [
      ['* a91f3c fix: memory leak', lime],
      ['* 7b22d0 feat: bug magnet', cyan],
      ['* 3c8e11 fix: firewall hole', lime],
      ['* e0f5a2 chore: deploy', '#9fb3ff'],
      ['* 11aa90 fix: null pointer', lime],
    ]);

    // 11 Chat / notifications
    [x, y] = cell(11);
    frame(x, y, 'notifications', '#ffd23a');
    lines(x + 22, y + 52, [
      ['● build passed', lime],
      ['● 12 bugs fixed today', cyan],
      ['● new client signup', '#ffd23a'],
      ['● server load normal', cyan],
    ], 18);

    // 12-15 Errors (corruption)
    const errs: [string, string[]][] = [
      ['FATAL ERROR', ['0x0000DEAD', 'kernel panic', 'core dumped']],
      ['WARNING', ['corrupted file', 'checksum mismatch', 'retry? [y/n]']],
      ['404', ['module not found', 'broken link', 'path: /void']],
      ['VIRUS ALERT', ['malware detected', 'quarantine failed', '!! !! !!']],
    ];
    errs.forEach(([title, body], i) => {
      [x, y] = cell(12 + i);
      ctx.fillStyle = 'rgba(60,0,10,0.65)';
      ctx.fillRect(x + 8, y + 8, CW - 16, CH - 16);
      ctx.fillStyle = '#ff2a4a';
      ctx.fillRect(x + 8, y + 8, CW - 16, 30);
      ctx.strokeStyle = '#ff2a4a';
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 9.5, y + 9.5, CW - 19, CH - 19);
      ctx.fillStyle = '#1a0004';
      ctx.font = `800 18px ${MONO}`;
      ctx.textBaseline = 'middle';
      ctx.fillText(`⚠ ${title}`, x + 20, y + 24);
      ctx.fillStyle = '#ff5a70';
      ctx.font = `900 46px ${MONO}`;
      ctx.fillText('⚠', x + 30, y + 120);
      lines(x + 110, y + 70, body.map((b) => [b, '#ff8a9a'] as [string, string]), 20);
    });
  }, { anisotropy: 4 });
}

export const KEY_LABELS = ['Esc', 'Ctrl', 'Alt', 'Tab', 'Enter', 'Shift', 'Del', 'F5', 'A', 'T', 'Y', '{ }', '</>', '⌘', '$', '#'];

export function keyAtlas(): THREE.CanvasTexture {
  return canvasTexture(1024, 1024, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 1024, 1024);
    KEY_LABELS.forEach((label, i) => {
      const x = (i % 4) * 256;
      const y = Math.floor(i / 4) * 256;
      ctx.fillStyle = '#fff';
      const size = label.length > 3 ? 64 : label.length > 1 ? 84 : 120;
      ctx.font = `800 ${size}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + 128, y + 136);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 6;
      ctx.strokeRect(x + 20, y + 20, 216, 216);
    });
  }, { srgb: false, anisotropy: 8 });
}

let glyphCache: THREE.CanvasTexture | null = null;

/** Shared 4x4 atlas of code glyphs (built once). */
export function glyphAtlas(): THREE.CanvasTexture {
  return (glyphCache ??= buildGlyphAtlas());
}

function buildGlyphAtlas(): THREE.CanvasTexture {
  const chars = ['0', '1', '{', '}', '<', '>', '/', ';', '=', '$', '#', '&', 'A', 'B', 'T', 'Y'];
  return canvasTexture(256, 256, (ctx) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 256, 256);
    ctx.fillStyle = '#fff';
    ctx.font = `700 50px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    chars.forEach((c, i) => ctx.fillText(c, (i % 4) * 64 + 32, Math.floor(i / 4) * 64 + 34));
  }, { srgb: false, anisotropy: 1 });
}

