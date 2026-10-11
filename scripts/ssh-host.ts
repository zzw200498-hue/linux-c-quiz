import * as fs from 'fs';
import * as path from 'path';

/**
 * 取 ssh 目标主机（用户名@主机IP）。
 *
 * 仓库里不放任何真实主机地址，优先级：
 *   1. 命令行传入
 *   2. 环境变量 QUIZ_SSH_HOST
 *   3. 本机工作区 .vscode/settings.json 里的 `quiz.sshHost`（该文件不入库）
 */
export function resolveSshHost(explicit?: string): string {
  if (explicit && explicit.includes('@')) return explicit;

  const fromEnv = process.env.QUIZ_SSH_HOST;
  if (fromEnv) return fromEnv;

  try {
    const file = path.join(__dirname, '..', '.vscode', 'settings.json');
    const txt = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const cfg = JSON.parse(txt) as Record<string, unknown>;
    const host = cfg['quiz.sshHost'];
    if (typeof host === 'string' && host.trim() !== '') return host;
  } catch {
    /* 没有本机配置就要求显式传入 */
  }

  console.error('没找到 ssh 目标主机：请传入参数（用户名@主机IP）或设环境变量 QUIZ_SSH_HOST');
  process.exit(1);
}
