/**
 * 构建桌面端：
 * 1. server/main.ts  → dist/server.cjs （Node，复用 VSCode 插件的 ssh runner / tester / 判分逻辑）
 * 2. web/app.ts      → dist/app.js     （浏览器，复用 src/shared 的题干切块与判分）
 * 3. Monaco（VSCode 同款编辑器内核）复制到 dist/monaco
 */
import { build } from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const dist = path.join(here, 'dist');

// 注意：这里刻意不整目录删除（一次性删上百个文件会触发安全拦截），改成覆盖式写入
fs.mkdirSync(dist, { recursive: true });

await build({
  entryPoints: [path.join(here, 'server', 'main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: path.join(dist, 'server.cjs'),
  logLevel: 'warning',
  external: ['electron'],
});

await build({
  entryPoints: [path.join(here, 'web', 'app.ts')],
  bundle: true,
  platform: 'browser',
  target: 'chrome110',
  format: 'iife',
  outfile: path.join(dist, 'app.js'),
  logLevel: 'warning',
});

// Monaco：复制 min/vs（逐个文件读写，cpSync 在本机会报 EIO）
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name);
    const d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.writeFileSync(d, fs.readFileSync(s));
  }
}

const src = path.join(root, 'node_modules', 'monaco-editor', 'min', 'vs');
const dst = path.join(dist, 'monaco', 'vs');
if (fs.existsSync(src)) {
  if (fs.existsSync(path.join(dst, 'loader.js'))) {
    console.log('[build] Monaco 已在位（跳过复制；要更新请先手动删除 dist/monaco）');
  } else {
    copyDir(src, dst);
    console.log('[build] Monaco 已就位');
  }
} else {
  console.warn('[build] 找不到 monaco-editor，代码编辑将退化成纯 textarea');
}

// Electron 打包目录。server 里静态资源的约定是「__dirname/../web」，
// 而打包后 server.cjs 落在 <应用>/app/server.cjs，所以网页必须放在 <应用>/web，
// 也就是这里的 desktop/electron/web（和 app/ 平级，不是 app/web）。
const appDir = path.join(here, 'electron', 'app');
const elecWeb = path.join(here, 'electron', 'web');
const appMonaco = path.join(elecWeb, 'monaco', 'vs');
fs.mkdirSync(appDir, { recursive: true });
fs.mkdirSync(elecWeb, { recursive: true });
fs.copyFileSync(path.join(dist, 'server.cjs'), path.join(appDir, 'server.cjs'));
fs.copyFileSync(path.join(dist, 'app.js'), path.join(elecWeb, 'app.js'));
fs.copyFileSync(path.join(here, 'web', 'index.html'), path.join(elecWeb, 'index.html'));
fs.copyFileSync(path.join(here, 'web', 'app.css'), path.join(elecWeb, 'app.css'));
if (fs.existsSync(src) && !fs.existsSync(path.join(appMonaco, 'loader.js'))) {
  copyDir(src, appMonaco);
}

console.log('[build] 完成 →', dist);
console.log('[build] Electron 运行目录 →', appDir);
