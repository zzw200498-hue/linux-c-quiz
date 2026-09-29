import * as vscode from 'vscode';
import type { RunResult } from '../shared/types';
import { LocalRunner } from './local';
import { SshRunner, resolveSshBin } from './ssh';
import type { ExecOptions, Runner, RunnerKind } from './types';

export type { Runner, RunnerKind, ExecOptions } from './types';

export type RunnerConfig = {
  mode: RunnerKind;
  sshHost: string;
  sshPath: string;
  remoteRoot: string;
  cCompiler: string;
  cppCompiler: string;
  timeoutMs: number;
};

export function readRunnerConfig(): RunnerConfig {
  const c = vscode.workspace.getConfiguration('quiz');
  const mode = c.get<string>('runner', 'local');
  return {
    mode: mode === 'ssh' || mode === 'off' ? mode : 'local',
    sshHost: c.get<string>('sshHost', '').trim(),
    sshPath: c.get<string>('sshPath', '').trim(),
    remoteRoot: c.get<string>('remoteRoot', '~/.quiz-runner').trim() || '~/.quiz-runner',
    cCompiler: c.get<string>('cCompiler', 'gcc').trim() || 'gcc',
    cppCompiler: c.get<string>('cppCompiler', 'g++').trim() || 'g++',
    timeoutMs: Math.max(1, c.get<number>('runTimeoutSec', 5)) * 1000,
  };
}

export function createRunner(cfg: RunnerConfig): Runner {
  if (cfg.mode === 'off') return new OffRunner();
  if (cfg.mode === 'ssh' && cfg.sshHost) {
    return new SshRunner(cfg.sshHost, cfg.remoteRoot, cfg.cCompiler, resolveSshBin(cfg.sshPath));
  }
  return new LocalRunner(cfg.cCompiler);
}

/** off：只作答不运行（纯做题模式） */
class OffRunner implements Runner {
  readonly kind = 'off' as const;

  describe(): string {
    return 'off（不运行）';
  }

  async prepare(localDir: string): Promise<string> {
    return localDir;
  }

  async exec(): Promise<RunResult> {
    return {
      cmd: '',
      exitCode: null,
      signal: null,
      stdout: '',
      stderr: '',
      timedOut: false,
      durationMs: 0,
      error: 'Runner 已关闭（quiz.runner = off）。',
    };
  }
}
