import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { capture } from '../runner/exec';
import { resolveSshBin } from '../runner/ssh';

/**
 * 把 VM 的系统头文件（/usr/include + gcc 内置头）拉到本地缓存 .quiz/sysroot/，
 * 并配置 C/C++ 扩展（cpptools 的 c_cpp_properties.json）与 clangd（.clangd）指向它。
 * 这样 Windows 本地编辑器里 unistd.h / pthread.h 不再红线，补全、跳转、签名提示全部真实生效。
 */

export type SysrootSshCfg = { host: string; sshPath?: string };

export function sysrootDir(wsRoot: string): string {
  return path.join(wsRoot, '.quiz', 'sysroot');
}

export function hasSysroot(wsRoot: string): boolean {
  return fs.existsSync(path.join(sysrootDir(wsRoot), 'usr', 'include', 'stdio.h'));
}

/** sysroot 下的头文件搜索路径（不带 /**，调用方自行追加） */
export function sysrootIncludePaths(wsRoot: string): string[] {
  const base = sysrootDir(wsRoot).replace(/\\/g, '/');
  const out = [`${base}/usr/include`, `${base}/usr/include/x86_64-linux-gnu`];
  const gccDir = path.join(sysrootDir(wsRoot), 'usr', 'lib', 'gcc');
  try {
    for (const arch of fs.readdirSync(gccDir)) {
      for (const ver of fs.readdirSync(path.join(gccDir, arch))) {
        out.push(`${base}/usr/lib/gcc/${arch}/${ver}/include`);
      }
    }
  } catch {
    /* gcc 内置头缺失不影响主 include */
  }
  return out;
}

function localTar(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  }
  return 'tar';
}

function unzip(tgz: string, dest: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(localTar(), ['-xzf', tgz, '-C', dest], { windowsHide: true });
    let err = '';
    child.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', (e) => resolve(e.message));
    child.on('close', (code) => resolve(code === 0 ? '' : err || `tar exit ${code}`));
  });
}

/** 写 .vscode/c_cpp_properties.json（保留用户已有配置，只追加 includePath） */
function writeCppProperties(wsRoot: string): void {
  const dir = path.join(wsRoot, '.vscode');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'c_cpp_properties.json');
  let props: Record<string, unknown> = { version: 4, configurations: [{}] };
  try {
    const raw = JSON.parse(
      fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').replace(/\/\/.*$/gm, ''),
    ) as Record<string, any>;
    if (raw && Array.isArray(raw.configurations)) props = raw;
  } catch {
    /* 不存在或损坏则重建 */
  }
  props.version = (props.version as number | undefined) ?? 4;
  const configs = (props.configurations as Record<string, unknown>[] | undefined) ?? [];
  if (configs.length === 0) configs.push({});
  props.configurations = configs;
  const conf = configs[0] as Record<string, any>;
  conf.name ??= 'Linux (quiz sysroot)';
  conf.intelliSenseMode ??= 'linux-gcc-x64';
  conf.cStandard ??= 'c11';
  conf.cppStandard ??= 'c++17';
  const inc = new Set<string>((conf.includePath as string[] | undefined) ?? []);
  for (const p of sysrootIncludePaths(wsRoot)) inc.add(`${p}/**`);
  conf.includePath = [...inc];
  fs.writeFileSync(file, JSON.stringify(props, null, 2) + '\n');
}

/** 写工作区根 .clangd（clangd 不展开 ${workspaceFolder}，用绝对路径） */
function writeClangd(wsRoot: string): void {
  const flags = sysrootIncludePaths(wsRoot).flatMap((p) => ['-isystem', p.replace(/\\/g, '/')]);
  const body = `# 由 Linux C Quiz 生成：本地补全用 VM 系统头文件\nCompileFlags:\n  Add:\n${flags
    .map((f) => `    - ${f}`)
    .join('\n')}\n`;
  fs.writeFileSync(path.join(wsRoot, '.clangd'), body);
}

export type SyncResult = { ok: boolean; message: string };

export async function syncSysroot(wsRoot: string, cfg: SysrootSshCfg): Promise<SyncResult> {
  const sshBin = resolveSshBin(cfg.sshPath);
  const dest = sysrootDir(wsRoot);

  const r = await capture(
    [
      sshBin,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=accept-new',
      cfg.host,
      'cd / && tar -czf - usr/include usr/lib/gcc 2>/dev/null | base64 -w0',
    ],
    { maxOutput: 96 * 1024 * 1024, timeoutMs: 600000 },
  );

  if (r.error) return { ok: false, message: `ssh 连接失败：${r.error}` };
  if (r.timedOut) return { ok: false, message: '下载超时。' };
  if (r.exitCode !== 0) {
    return { ok: false, message: `VM 打包头文件失败（exit ${r.exitCode}）：${(r.stderr || r.stdout).slice(0, 300)}` };
  }

  const buf = Buffer.from(r.stdout.trim(), 'base64');
  if (buf.length < 1024 * 1024) {
    return { ok: false, message: `下载内容异常（${(buf.length / 1024).toFixed(0)} KB），检查 ssh 输出是否被污染。` };
  }

  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const tgz = path.join(dest, 'sysroot.tar.gz');
  fs.writeFileSync(tgz, buf);
  const err = await unzip(tgz, dest);
  fs.rmSync(tgz, { force: true });
  if (err) return { ok: false, message: `解压失败：${err}` };
  if (!fs.existsSync(path.join(dest, 'usr', 'include', 'stdio.h'))) {
    return { ok: false, message: '解压完成但没找到 stdio.h，tar 包内容异常。' };
  }

  writeCppProperties(wsRoot);
  writeClangd(wsRoot);

  const sizeMb = (buf.length / (1024 * 1024)).toFixed(1);
  return {
    ok: true,
    message: `VM 系统头文件已就绪（压缩包 ${sizeMb} MB → ${path.relative(wsRoot, dest)}），C/C++ 扩展与 clangd 配置已写入工作区。`,
  };
}
