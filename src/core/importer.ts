import * as vscode from 'vscode';
import * as fs from 'fs';
import { load as yamlLoad } from 'js-yaml';
import { paperSchema, TYPE_LABEL } from '../shared/types';
import type { Store } from './store';

/** 从一段文本中提取 yaml 内容：优先取 ```yaml 围栏块，否则按整篇处理 */
export function extractYaml(text: string): string {
  const fence = /```ya?ml\s*\r?\n([\s\S]*?)```/i.exec(text);
  return fence ? fence[1] : text;
}

export async function importPaperFromUri(store: Store, uri: vscode.Uri): Promise<void> {
  const text = fs.readFileSync(uri.fsPath, 'utf8');
  let data: unknown;
  try {
    data = yamlLoad(extractYaml(text));
  } catch (e) {
    void vscode.window.showErrorMessage(`导入失败：YAML 语法错误 —— ${String(e)}`);
    return;
  }

  const parsed = paperSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 6)
      .map((i) => `  · ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    void vscode.window.showErrorMessage(
      `导入失败：字段校验未通过（共 ${parsed.error.issues.length} 处）\n${issues}`,
      { modal: true },
    );
    return;
  }

  const p = parsed.data;
  const counts = new Map<string, number>();
  for (const q of p.questions) counts.set(q.type, (counts.get(q.type) ?? 0) + 1);
  const summary = [...counts.entries()].map(([t, n]) => `${TYPE_LABEL[t as keyof typeof TYPE_LABEL]}×${n}`).join('，');

  const name = await store.savePaper(p.paper.title, data);
  await vscode.window.showInformationMessage(
    `已导入《${p.paper.title}》：${p.questions.length} 题（${summary}）→ bank/${name}`,
  );
}
