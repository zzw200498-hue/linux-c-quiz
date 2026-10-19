import * as vscode from 'vscode';
import * as fs from 'fs';
import { load as yamlLoad } from 'js-yaml';
import { lintPaper, parsePaperText, paperTypeSummary, extractYaml } from '../shared/importer';
import type { Store } from './store';

export { extractYaml };

export async function importPaperFromUri(store: Store, uri: vscode.Uri): Promise<void> {
  const text = fs.readFileSync(uri.fsPath, 'utf8');

  const r = parsePaperText(text, (raw) => yamlLoad(raw));
  if (!r.ok) {
    const detail =
      r.stage === 'yaml'
        ? r.message
        : `${r.message}\n${(r.issues ?? []).map((i) => `  · ${i}`).join('\n')}`;
    void vscode.window.showErrorMessage(`导入失败：${detail}`, { modal: true });
    return;
  }

  // schema 过了不代表能做（选择题没选项、题号重复这类），先过一遍质量检查
  const lint = lintPaper(r.data);
  if (lint.errors.length) {
    const detail = `${lint.errors.length} 处做不了的地方：\n${lint.errors
      .map((e) => `  · ${e}`)
      .join('\n')}`;
    void vscode.window.showErrorMessage(`导入失败：${detail}`, { modal: true });
    return;
  }

  const p = r.data;
  const name = await store.savePaper(p.paper.title, p);
  const summary = paperTypeSummary(p.questions);
  const msg = `已导入《${p.paper.title}》：${p.questions.length} 题（${summary}）→ bank/${name}`;
  if (lint.warnings.length) {
    void vscode.window.showWarningMessage(
      `${msg}\n提醒：${lint.warnings.slice(0, 4).join('；')}${lint.warnings.length > 4 ? `；等 ${lint.warnings.length} 条` : ''}`,
    );
  } else {
    void vscode.window.showInformationMessage(msg);
  }
}
