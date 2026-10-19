/**
 * 启动桌面端：起本地服务，然后用 Edge 的 --app 模式开一个独立窗口（没有地址栏和标签页，看起来就是个桌面程序）。
 * 用法：node desktop/launch.mjs
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const port = process.env.QUIZ_PORT ?? 5733;
const url = `http://127.0.0.1:${port}`;

const server = spawn(process.execPath, [path.join(here, 'dist', 'server.cjs')], {
  stdio: 'inherit',
  env: process.env,
});

function findEdge() {
  const candidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  for (const p of candidates) if (fs.existsSync(p)) return p;
  return null;
}

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${url}/api/config`);
      if (r.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

const ok = await waitReady();
if (!ok) {
  console.error('[launch] 服务没起来，看看上面的报错');
  process.exit(1);
}

const edge = findEdge();
if (edge) {
  spawn(edge, ['--app=' + url, '--window-size=1240,800', '--disable-features=Translate'], {
    detached: true,
    stdio: 'ignore',
  }).unref();
  console.log('[launch] 已在独立窗口打开：', url);
} else {
  console.log('[launch] 没找到 Edge，请手动打开：', url);
}

process.on('SIGINT', () => {
  server.kill();
  process.exit(0);
});
