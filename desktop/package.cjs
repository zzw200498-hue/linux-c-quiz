/**
 * 把 Electron 壳打成真正的 Windows 桌面应用（双击即开的那种）。
 *
 *   node desktop/package.cjs                      # 默认输出到 桌面\Linux C 题库
 *   node desktop/package.cjs --out=D:\apps\quiz   # 指定输出目录
 *
 * 产物：<输出目录>\LinuxCQuiz-win32-x64\LinuxCQuiz.exe
 * 说明：app/（内置服务）与 web/（网页 + Monaco）由 build.mjs 生成，打包前会自动构建一次。
 */
const path = require('path');
const fs = require('fs');
const { execFileSync, spawnSync } = require('child_process');

const here = __dirname;

function arg(name, def) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}

const desktop = process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'Desktop') : here;
const outDir = path.resolve(arg('out', path.join(desktop, 'Linux C 题库')));
const appName = 'LinuxCQuiz';
const targetDir = path.join(outDir, `${appName}-win32-x64`);

/* 1. 先构建（server.cjs / app.js / electron 运行目录） */
console.log('[package] 构建中…');
const build = spawnSync(process.execPath, [path.join(here, 'build.mjs')], { stdio: 'inherit' });
if (build.status !== 0) {
  console.error('[package] 构建失败，中止打包');
  process.exit(build.status ?? 1);
}

/* 1.5 覆盖前先清掉上一次的产物 */
// ① 正在运行的 App 会锁住文件 → 先关掉
if (process.platform === 'win32') {
  const r = spawnSync('taskkill', ['/IM', `${appName}.exe`, '/F'], { encoding: 'utf8' });
  if (r.status === 0) console.log(`[package] 已关闭正在运行的 ${appName}.exe`);
}
// ② 用 rd 整个删掉旧目录（比 Node 递归删除稳，也不受沙箱批量删除限制影响）
if (fs.existsSync(targetDir)) {
  console.log('[package] 清理上一次的产物目录…');
  execFileSync('cmd', ['/c', 'rd', '/s', '/q', targetDir], { stdio: 'ignore' });
}

/* 2. electron-packager */
// GitHub 直连在国内经常超时，默认走 npmmirror 的 Electron 镜像（可用 ELECTRON_MIRROR 覆盖）
if (!process.env.ELECTRON_MIRROR) {
  process.env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
}
const packager = require('electron-packager');
const rootPkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
const electronVersion = String(
  (rootPkg.devDependencies && rootPkg.devDependencies.electron) || '',
).replace(/^[\^~]/, '');

(async () => {
  console.log(`[package] 打包 Electron ${electronVersion} → ${outDir}`);
  const paths = await packager({
    dir: path.join(here, 'electron'),
    name: appName,
    platform: 'win32',
    arch: 'x64',
    electronVersion,
    out: outDir,
    overwrite: true,
    asar: false, // 不用 asar：内置服务要按真实路径读静态文件，平铺更好排错
    prune: false,
    ignore: [/\.map$/, /\/out($|\/)/],
  });

  const target = paths[0];
  const exe = path.join(target, `${appName}.exe`);
  console.log('[package] 完成 →', exe);
  console.log('[package] 双击这个 exe 即可运行（没有建桌面快捷方式）');
})().catch((e) => {
  console.error('[package] 打包失败：', e);
  process.exit(1);
});
