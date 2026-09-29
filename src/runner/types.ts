import type { RunResult } from '../shared/types';
import { capture } from './exec';

export type ExecOptions = { stdin?: string; timeoutMs: number };

export type RunnerKind = 'local' | 'ssh' | 'off';

export interface Runner {
  readonly kind: RunnerKind;
  describe(): string;
  /**
   * 执行前的目录准备。local 模式原样返回本地目录；
   * ssh 模式把本地 scratch 目录同步到远端，返回远端 cwd。
   */
  prepare(localDir: string): Promise<string>;
  /** 在 cwd 中执行 argv（ssh 模式下 cwd 是远端路径） */
  exec(cwd: string, argv: string[], opts: ExecOptions): Promise<RunResult>;
}

/** POSIX 单引号转义，用于拼 ssh 远端命令 */
export function sh(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
