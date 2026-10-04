import * as fs from 'fs';
import * as vscode from 'vscode';
import type { HostToWeb, PaperFile, WebToHost } from '../shared/types';
import type { Store } from '../core/store';
import { ScratchManager } from '../core/scratch';
import { runQuestionTests } from '../core/tester';
import { createRunner, readRunnerConfig } from '../runner';
import type { PapersProvider } from './sidebar';

export class QuizPanel {
  private static panel?: vscode.WebviewPanel;
  private static paper?: PaperFile;
  private static bound = false;
  private static scratch?: ScratchManager;

  static get currentPaperFile(): string | undefined {
    return this.paper?.file;
  }

  static show(
    ctx: vscode.ExtensionContext,
    store: Store,
    provider: PapersProvider,
    paper: PaperFile,
    startQid?: string,
  ): void {
    this.paper = paper;
    this.scratch ??= new ScratchManager(store);

    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel('quizPanel', paper.paper.title, vscode.ViewColumn.One, {
        enableScripts: true,
        retainContextWhenHidden: true,
      });
      this.panel.webview.html = this.html(this.panel.webview, ctx.extensionUri);
      this.bind(ctx, store, provider);
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
    } else {
      this.panel.title = paper.paper.title;
      this.panel.reveal();
    }

    void this.postInit(store, startQid ?? null);
  }

  private static post(msg: HostToWeb): void {
    void this.panel?.webview.postMessage(msg);
  }

  private static async postInit(store: Store, startQid: string | null): Promise<void> {
    if (!this.panel || !this.paper) return;
    const st = await store.loadState();
    this.post({
      type: 'init',
      data: {
        paperTitle: this.paper.paper.title,
        paperFile: this.paper.file,
        questions: this.paper.questions,
        startQid,
        answers: st.papers[this.paper.file] ?? {},
        summary: st.summaries[this.paper.file] ?? null,
      },
    });
  }

  /** 把当前卷最新成绩单推送给 Webview（只读广播；重算由 mergeGrades / syncSummary 负责） */
  static async postSummary(store: Store): Promise<void> {
    if (!this.panel || !this.paper) return;
    const summary = await store.getSummary(this.paper.file);
    if (summary) this.post({ type: 'summaryUpdated', data: summary });
  }

  private static bind(
    ctx: vscode.ExtensionContext,
    store: Store,
    provider: PapersProvider,
  ): void {
    if (this.bound) return;
    this.bound = true;

    /* 用户在真实编辑器里保存 scratch 代码 → 回写作答并同步到 Webview */
    ctx.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const meta = this.scratch?.metaForUri(doc.uri);
        if (!meta) return;
        const code = doc.getText();
        await store.saveAnswer(meta.paperFile, meta.qid, { value: code, correct: null });
        if (this.paper?.file === meta.paperFile) {
          this.post({ type: 'scratchSaved', qid: meta.qid, code });
        }
        await provider.refresh();
      }),
    );

    this.panel!.webview.onDidReceiveMessage(async (msg: WebToHost) => {
      switch (msg.type) {
        case 'ready':
          await this.postInit(store, null);
          break;
        case 'saveAnswer':
          if (this.paper) {
            await store.saveAnswer(this.paper.file, msg.qid, {
              value: msg.value,
              correct: msg.correct,
            });
            await provider.refresh();
          }
          break;
        case 'copyText':
          await vscode.env.clipboard.writeText(msg.text);
          void vscode.window.showInformationMessage('已复制到剪贴板。');
          break;
        case 'openScratch':
          await this.openScratch(store, provider, msg.qid, msg.code);
          break;
        case 'runTests':
          await this.runTests(store, provider, msg.qid, msg.code);
          break;
        case 'syncSummary':
          if (this.paper) {
            await store.refreshSummary(this.paper.file);
            await this.postSummary(store);
            await provider.refresh();
          }
          break;
      }
    });
  }

  /** 打开真实编辑器：scratch 目录 + 模板/用户代码，Webview 保留在旁 */
  private static async openScratch(
    store: Store,
    provider: PapersProvider,
    qid: string,
    webCode: string,
  ): Promise<void> {
    const paper = this.paper;
    const q = paper?.questions.find((x) => x.id === qid);
    // 传入 Webview 当前作答内容：简答/改写题首次打开时据此猜测入口文件类型（Makefile / main.c / answer.txt）
    const info = paper && q ? this.scratch?.ensure(paper.file, q, webCode) : undefined;
    if (!paper || !q || !info) {
      void vscode.window.showErrorMessage('请先在工作区中打开试卷。');
      return;
    }

    const doc = this.scratch!.findDoc(info.entryPath);
    const disk = fs.existsSync(info.entryPath) ? fs.readFileSync(info.entryPath, 'utf8') : '';
    if (!doc && typeof webCode === 'string' && webCode.trim() && webCode !== disk) {
      // 用户在 Webview 里写了代码但还没进编辑器 → 以 Webview 内容为准
      fs.writeFileSync(info.entryPath, webCode, 'utf8');
      await store.saveAnswer(paper.file, qid, { value: webCode, correct: null });
      await provider.refresh();
    }

    await vscode.window.showTextDocument(vscode.Uri.file(info.entryPath), {
      viewColumn: vscode.ViewColumn.Beside,
      preview: false,
    });
  }

  /** 编译运行 + 用例比对，结果发回 Webview 展示 */
  private static async runTests(
    store: Store,
    provider: PapersProvider,
    qid: string,
    webCode: string,
  ): Promise<void> {
    const paper = this.paper;
    const q = paper?.questions.find((x) => x.id === qid);
    const info = paper && q ? this.scratch?.ensure(paper.file, q) : undefined;
    if (!paper || !q || !info) return;

    // 代码来源优先级：已打开的编辑器（含未保存修改）> Webview 里的新内容 > 磁盘
    let code = '';
    const doc = this.scratch!.findDoc(info.entryPath);
    if (doc) {
      if (doc.isDirty) await doc.save();
      code = doc.getText();
    } else {
      const disk = fs.existsSync(info.entryPath) ? fs.readFileSync(info.entryPath, 'utf8') : '';
      if (typeof webCode === 'string' && webCode.trim() && webCode !== disk) {
        fs.writeFileSync(info.entryPath, webCode, 'utf8');
        code = webCode;
      } else {
        code = disk;
      }
    }

    const cfg = readRunnerConfig();
    const summary = await runQuestionTests(createRunner(cfg), q, info.dir, {
      cCompiler: cfg.cCompiler,
      cppCompiler: cfg.cppCompiler,
      timeoutMs: cfg.timeoutMs,
    });

    await store.saveAnswer(paper.file, qid, {
      value: code,
      correct: null,
      lastRun: { passed: summary.passed, total: summary.total, ts: Date.now() },
    });

    this.post({ type: 'runResults', qid, data: summary });
    await provider.refresh();
  }

  private static html(webview: vscode.Webview, extUri: vscode.Uri): string {
    const nonce = Array.from({ length: 24 }, () => Math.random().toString(36)[2] ?? '0').join('');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'dist', 'webview.js'));
    const css = webview.asWebviewUri(vscode.Uri.joinPath(extUri, 'dist', 'webview.css'));
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<link rel="stylesheet" href="${css}">
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}
