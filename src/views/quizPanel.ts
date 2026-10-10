import * as fs from 'fs';
import * as vscode from 'vscode';
import type { Answer, HostToWeb, PaperFile, Question, WebToHost } from '../shared/types';
import type { Store } from '../core/store';
import { shuffle, buildWrongbookQuestions } from '../shared/wrongbook';
import type { WrongbookQuestionSource } from '../shared/wrongbook';
import { ScratchManager } from '../core/scratch';
import { runQuestionTests } from '../core/tester';
import { createRunner, readRunnerConfig } from '../runner';
import type { PapersProvider } from './sidebar';

export class QuizPanel {
  private static panel?: vscode.WebviewPanel;
  private static paper?: PaperFile;
  private static bound = false;
  private static scratch?: ScratchManager;
  /** 错题本模式：面板题 id（`试卷#题id`）→ 原卷 + 原题 id */
  private static wrongbookSource?: Record<string, WrongbookQuestionSource>;
  private static wrongbookKind?: 'active' | 'passed';

  static get currentPaperFile(): string | undefined {
    // 错题本模式下没有单一来源卷，返回 undefined（导入批改等命令会退回让用户选卷）
    return this.wrongbookSource ? undefined : this.paper?.file;
  }

  /**
   * 面板题 id → 实际作答存储位置（原卷文件名 + 原题 id）。
   * 错题本模式下题 id 带卷名前缀，这里还原；普通卷就是题 id 本身。
   */
  private static resolveTarget(panelQid: string): WrongbookQuestionSource {
    const hit = this.wrongbookSource?.[panelQid];
    if (hit) return hit;
    return { paper: this.paper?.file ?? '', qid: panelQid };
  }

  /** 反向查：某来源卷的某道题在当前面板里对应哪个题 id（scratch 保存回写时用） */
  private static panelQidFor(paper: string, qid: string): string | undefined {
    if (this.wrongbookSource) {
      for (const [id, v] of Object.entries(this.wrongbookSource)) {
        if (v.paper === paper && v.qid === qid) return id;
      }
      return undefined;
    }
    return this.paper?.file === paper ? qid : undefined;
  }

  /** 打开错题本刷题：跨卷抽题 + 随机顺序 */
  static async showWrongbook(
    ctx: vscode.ExtensionContext,
    store: Store,
    provider: PapersProvider,
    kind: 'active' | 'passed',
  ): Promise<void> {
    await store.syncWrongbook();
    const entries = await store.wrongbookEntries(kind);
    if (entries.length === 0) {
      void vscode.window.showInformationMessage(
        kind === 'active'
          ? '错题本是空的：还没有判错的题。先做卷子（交卷判定 / 导入批改）就会自动收录错题。'
          : '还没有过关的题：在错题本里连续答对 3 次即毕业。',
      );
      return;
    }

    const items: { paperFile: string; q: Question }[] = [];
    const cache = new Map<string, PaperFile>();
    for (const e of entries) {
      let p = cache.get(e.paper);
      if (!p) {
        const loaded = await store.loadPaper(e.paper);
        if (!loaded) continue;
        p = loaded;
        cache.set(e.paper, p);
      }
      const q = p.questions.find((x) => x.id === e.qid);
      if (q) items.push({ paperFile: e.paper, q });
    }
    if (items.length === 0) {
      void vscode.window.showWarningMessage('错题对应的题目在题库里找不到了（试卷可能被删掉或改过）。');
      return;
    }

    shuffle(items);
    // 题 id 唯一化（`试卷#题id`）：不同卷里都有 q1，直接用原 id 会让面板状态跨卷串台
    const { questions, source } = buildWrongbookQuestions(items);

    const paper: PaperFile = {
      file: `wrongbook:${kind}`,
      paper: {
        title:
          kind === 'active'
            ? `错题本 · 待攻克（${questions.length} 题 · 随机顺序）`
            : `已过关错题（${questions.length} 题）`,
        topics: [],
      },
      questions,
    };
    this.wrongbookSource = source;
    this.wrongbookKind = kind;
    this.show(ctx, store, provider, paper);
  }

  static show(
    ctx: vscode.ExtensionContext,
    store: Store,
    provider: PapersProvider,
    paper: PaperFile,
    startQid?: string,
  ): void {
    this.paper = paper;
    // 打开普通卷时清掉错题本上下文（showWrongbook 会先设好再调 show）
    if (!paper.file.startsWith('wrongbook:')) {
      this.wrongbookSource = undefined;
      this.wrongbookKind = undefined;
    }
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
    const wrong = this.wrongbookSource;
    const answers: Record<string, Answer> = {};
    if (wrong) {
      // 错题本：答案分散在各来源卷里（面板题 id → 原卷 + 原题 id）
      for (const q of this.paper.questions) {
        const src = wrong[q.id];
        const a = src ? st.papers[src.paper]?.[src.qid] : undefined;
        if (a) answers[q.id] = a;
      }
    } else {
      Object.assign(answers, st.papers[this.paper.file] ?? {});
    }
    const progress: Record<string, { streak: number; passed: boolean; tries: number }> = {};
    if (wrong) {
      for (const q of this.paper.questions) {
        const src = wrong[q.id];
        if (!src) continue;
        const e = st.wrongbook[`${src.paper}#${src.qid}`];
        if (e) progress[q.id] = { streak: e.streak, passed: e.passed, tries: e.tries };
      }
    }
    this.post({
      type: 'init',
      data: {
        paperTitle: this.paper.paper.title,
        paperFile: this.paper.file,
        questions: this.paper.questions,
        startQid,
        answers,
        summary: wrong ? null : (st.summaries[this.paper.file] ?? null),
        ...(wrong
          ? { wrongbook: { kind: this.wrongbookKind ?? 'active', source: wrong, progress } }
          : {}),
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
        const panelQid = this.panelQidFor(meta.paperFile, meta.qid);
        if (panelQid) this.post({ type: 'scratchSaved', qid: panelQid, code });
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
            const t = this.resolveTarget(msg.qid);
            if (!t.paper) break;
            await store.saveAnswer(t.paper, t.qid, {
              value: msg.value,
              correct: msg.correct,
            });
            await provider.refresh();
          }
          break;
        case 'saveWrongbookAnswer': {
          const t = this.resolveTarget(msg.qid);
          if (!t.paper) break;
          await store.saveAnswer(t.paper, t.qid, { value: msg.value, correct: msg.correct });
          const before = await store.wrongbookEntries(this.wrongbookKind ?? 'active');
          const wasPassed = before.find((e) => e.paper === t.paper && e.qid === t.qid)?.passed ?? false;
          const entry = await store.recordWrongbookPractice(t.paper, t.qid, msg.correct);
          await provider.refresh();
          if (entry) {
            this.post({
              type: 'wrongbookProgress',
              qid: msg.qid,
              streak: entry.streak,
              passed: entry.passed,
              graduated: entry.passed && !wasPassed,
            });
          }
          break;
        }
        case 'selfGrade': {
          // 只开放给错题本 / 随机刷题模式（正式卷仍走导出 → AI 批改 → 导入）
          if (!this.wrongbookSource) break;
          const t = this.resolveTarget(msg.qid);
          if (!t.paper) break;
          const before = await store.wrongbookEntries(this.wrongbookKind ?? 'active');
          const wasPassed = before.find((e) => e.paper === t.paper && e.qid === t.qid)?.passed ?? false;
          const { grade, entry } = await store.saveSelfGrade(t.paper, t.qid, msg.score);
          await provider.refresh();
          this.post({ type: 'selfGraded', qid: msg.qid, grade });
          if (entry) {
            this.post({
              type: 'wrongbookProgress',
              qid: msg.qid,
              streak: entry.streak,
              passed: entry.passed,
              graduated: entry.passed && !wasPassed,
            });
          }
          break;
        }
        case 'selfJudge': {
          // 客观题自评（错题本 / 随机刷题模式）：pass=true 计一次连对，false 打回待攻克
          if (!this.wrongbookSource) break;
          const t = this.resolveTarget(msg.qid);
          if (!t.paper) break;
          const before = await store.wrongbookEntries(this.wrongbookKind ?? 'active');
          const wasPassed = before.find((e) => e.paper === t.paper && e.qid === t.qid)?.passed ?? false;
          const entry = await store.recordWrongbookPractice(t.paper, t.qid, msg.pass);
          await provider.refresh();
          if (entry) {
            this.post({
              type: 'wrongbookProgress',
              qid: msg.qid,
              streak: entry.streak,
              passed: entry.passed,
              graduated: entry.passed && !wasPassed,
            });
          }
          break;
        }
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
    // 错题本模式下题目来自别的卷：作答写回、scratch 目录都要挂到原卷 + 原题 id 名下
    const t = q ? this.resolveTarget(q.id) : undefined;
    const info =
      paper && q && t && t.paper
        ? this.scratch?.ensure(t.paper, { ...q, id: t.qid }, webCode)
        : undefined;
    if (!paper || !q || !t || !t.paper || !info) {
      void vscode.window.showErrorMessage('请先在工作区中打开试卷。');
      return;
    }

    const doc = this.scratch!.findDoc(info.entryPath);
    const disk = fs.existsSync(info.entryPath) ? fs.readFileSync(info.entryPath, 'utf8') : '';
    if (!doc && typeof webCode === 'string' && webCode.trim() && webCode !== disk) {
      // 用户在 Webview 里写了代码但还没进编辑器 → 以 Webview 内容为准
      fs.writeFileSync(info.entryPath, webCode, 'utf8');
      await store.saveAnswer(t.paper, t.qid, { value: webCode, correct: null });
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
    const t = q ? this.resolveTarget(q.id) : undefined;
    const info =
      paper && q && t && t.paper ? this.scratch?.ensure(t.paper, { ...q, id: t.qid }) : undefined;
    if (!paper || !q || !t || !t.paper || !info) return;

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

    await store.saveAnswer(t.paper, t.qid, {
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
