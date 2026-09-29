import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Question } from '../shared/types';
import type { Store } from './store';

export type ScratchMeta = { paperFile: string; qid: string };

export type ScratchInfo = {
  /** 本地 scratch 目录（runner.local 直接用；runner.ssh 会整体同步到远端） */
  dir: string;
  entryPath: string;
  entryName: string;
  lang: string;
};

/** 编程题在 scratch 目录里的入口文件名 */
export function entryFileFor(q: Question): { name: string; lang: string } {
  const lang = (q.language ?? 'c').toLowerCase();
  if (lang === 'makefile') return { name: 'Makefile', lang };
  if (lang === 'python' || lang === 'py') return { name: 'main.py', lang };
  if (lang === 'cpp' || lang === 'c++') return { name: 'main.cpp', lang };
  return { name: 'main.c', lang };
}

/**
 * 简答/改写题的入口文件猜测（这些题没有 language 字段，按内容推断）：
 * - 题干/参考答案/用户作答提到 Makefile → Makefile（makefile 语法高亮）
 * - 含 #include / int main / printf 等 → main.c（C 补全生效）
 * - 其余（纯命令序列、文字叙述）→ answer.txt（纯文本，避免 C 补全红线干扰）
 */
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
 * 编程题工作目录：.quiz/scratch/<试卷>/<题号>/
 * - 入口文件（main.c / Makefile / main.py…）：首次写入模板，之后由用户在真实编辑器里编辑
 * - q.files：配套固定文件（输入样例 source.txt、多文件工程的其它源码），缺失时补齐
 * - .meta.json：记录归属（保存事件回写作答时反查）
 */
export class ScratchManager {
  constructor(private store: Store) {}

  ensure(paperFile: string, q: Question, userText?: string): ScratchInfo | undefined {
    const root = this.store.wsRoot;
    if (!root) return undefined;
    const paperDir = safeName(paperFile.replace(/\.[^.]+$/, ''));
    const dir = path.join(root.fsPath, '.quiz', 'scratch', paperDir, q.id);
    fs.mkdirSync(dir, { recursive: true });

    const meta: ScratchMeta = { paperFile, qid: q.id };
    fs.writeFileSync(path.join(dir, '.meta.json'), JSON.stringify(meta), 'utf8');

    const entry = q.type === 'short' || q.type === 'rewrite' ? entryFileForSubjective(q, userText) : entryFileFor(q);
    const entryPath = path.join(dir, entry.name);
    if (!fs.existsSync(entryPath)) {
      fs.writeFileSync(entryPath, q.templateCode ?? '', 'utf8');
    }

    for (const [name, content] of Object.entries(q.files ?? {})) {
      const p = path.join(dir, name);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      if (!fs.existsSync(p)) fs.writeFileSync(p, content, 'utf8');
    }

    return { dir, entryPath, entryName: entry.name, lang: entry.lang };
  }

  /** 通过 .meta.json 反查文件归属（用于保存事件回写作答） */
  metaForUri(uri: vscode.Uri): ScratchMeta | undefined {
    const dir = path.dirname(uri.fsPath);
    if (!dir.includes(`${path.sep}.quiz${path.sep}scratch${path.sep}`)) return undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, '.meta.json'), 'utf8')) as ScratchMeta;
      if (typeof raw.paperFile === 'string' && typeof raw.qid === 'string') return raw;
    } catch {
      /* 不是我们的 scratch 文件 */
    }
    return undefined;
  }

  /** 找到已打开（可能带未保存修改）的入口文件文档 */
  findDoc(entryPath: string): vscode.TextDocument | undefined {
    return vscode.workspace.textDocuments.find((d) => d.uri.fsPath === entryPath);
  }
}
