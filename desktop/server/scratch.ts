import * as fs from 'fs';
import * as path from 'path';
import type { Question } from '../../src/shared/types';
import type { QuizConfig } from './config';

/** 编程题在 scratch 目录里的入口文件名（与 VSCode 版一致，保证两边打开的是同一份文件） */
export function entryFileFor(q: Question): { name: string; lang: string } {
  const lang = (q.language ?? 'c').toLowerCase();
  if (lang === 'makefile') return { name: 'Makefile', lang };
  if (lang === 'python' || lang === 'py') return { name: 'main.py', lang };
  if (lang === 'cpp' || lang === 'c++') return { name: 'main.cpp', lang };
  return { name: 'main.c', lang };
}

/** 简答/改写题入口文件猜测：提 Makefile → Makefile；含 C 代码特征 → main.c；否则 answer.txt */
export function entryFileForSubjective(q: Question, userText?: string): { name: string; lang: string } {
  const text = [q.stem, q.referenceAnswer ?? '', q.templateCode ?? '', userText ?? ''].join('\n');
  if (/makefile/i.test(text)) return { name: 'Makefile', lang: 'makefile' };
  if (/#include|\bint\s+main\b|printf\s*\(|\bstruct\s+\w+\s*\{/.test(text)) return { name: 'main.c', lang: 'c' };
  return { name: 'answer.txt', lang: 'plaintext' };
}

function safeName(s: string): string {
  return s.replace(/[\\/:*?"<>|\s]+/g, '-').slice(0, 60) || 'paper';
}

/**
 * 桌面端的 scratch 管理器：目录结构与 VSCode 版完全一致
 * （.quiz/scratch/<试卷>/<题号>/），所以在 App 里写的代码，回到 VSCode 打开还是同一份。
 */
export class NodeScratch {
  constructor(private cfg: QuizConfig) {}

  ensure(paperFile: string, q: Question, userText?: string) {
    const paperDir = safeName(paperFile.replace(/\.[^.]+$/, ''));
    const dir = path.join(this.cfg.scratchDir, paperDir, q.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify({ paperFile, qid: q.id }), 'utf8');

    const entry = q.type === 'short' || q.type === 'rewrite' ? entryFileForSubjective(q, userText) : entryFileFor(q);
    const entryPath = path.join(dir, entry.name);
    if (!fs.existsSync(entryPath)) fs.writeFileSync(entryPath, q.templateCode ?? '', 'utf8');

    for (const [name, content] of Object.entries(q.files ?? {})) {
      const p = path.join(dir, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf8');
    }
    return { dir, entryPath, entryName: entry.name, lang: entry.lang };
  }

  /** 读取当前代码：优先读 scratch 文件，没有则用已保存的作答 / 模板 */
  read(paperFile: string, q: Question, fallback = ''): { code: string; entryName: string; lang: string; dir: string } {
    const info = this.ensure(paperFile, q, fallback);
    const code = fs.existsSync(info.entryPath) ? fs.readFileSync(info.entryPath, 'utf8') : fallback;
    return { code, entryName: info.entryName, lang: info.lang, dir: info.dir };
  }

  write(paperFile: string, q: Question, code: string): string {
    const info = this.ensure(paperFile, q, code);
    fs.writeFileSync(info.entryPath, code, 'utf8');
    return info.entryPath;
  }
}
