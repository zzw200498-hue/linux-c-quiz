import * as vscode from 'vscode';
import { Store } from './core/store';
import { readRunnerConfig } from './runner';
import { LocalRunner } from './runner/local';
import { SshRunner, resolveSshBin } from './runner/ssh';
import { capture } from './runner/exec';
import { PapersProvider, PaperNode, QuestionNode } from './views/sidebar';
import { QuizPanel } from './views/quizPanel';
import { importPaperFromUri } from './core/importer';
import { ScratchManager } from './core/scratch';
import { syncSysroot, hasSysroot } from './core/sysroot';
import { verifyPaperSolutions } from './core/verify';
import { renderPaperKnowledge } from './shared/knowledge';
import {
  readPrompt,
  exportAnswers,
  importGradesFromClipboard,
  importGradesFromImportDir,
} from './core/review';

/** 兼容多种调用来源：文件名、树节点对象、Uri、TreeItem */
function resolvePaperFile(arg: unknown): string | undefined {
  if (typeof arg === 'string' && arg) return arg;
  if (arg && typeof arg === 'object') {
    const a = arg as Record<string, any>;
    const candidates = [
      a.file,
      a.paper?.file,
      a.fsPath,
      a.resourceUri?.fsPath,
      a.command?.arguments?.[0],
      a.label,
    ];
    for (const c of candidates) if (typeof c === 'string' && c) return c;
  }
  return undefined;
}

function describeArg(arg: unknown): string {
  if (arg === undefined) return 'undefined';
  if (arg === null) return 'null';
  if (typeof arg !== 'object') return `${typeof arg}:${String(arg)}`;
  try {
    return `object keys=${Object.keys(arg as object).join(',')} json=${JSON.stringify(arg).slice(0, 300)}`;
  } catch {
    return `object ctor=${(arg as any)?.constructor?.name ?? '?'}`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new Store(context);
  const provider = new PapersProvider(store);
  const scratch = new ScratchManager(store);
  const out = vscode.window.createOutputChannel('Quiz');
  const tree = vscode.window.createTreeView('linux-c-quiz.papers', { treeDataProvider: provider });
  context.subscriptions.push(tree, out);

  const requireWs = (): vscode.Uri | undefined => {
    const root = store.wsRoot;
    if (!root) void vscode.window.showErrorMessage('请先打开一个工作区文件夹（题库 bank/ 将放在其下）。');
    return root;
  };

  /** ssh 模式且本地还没有 VM 头文件缓存时，自动拉一次（本地编辑器补全用） */
  const ensureSysroot = async (): Promise<void> => {
    const root = store.wsRoot?.fsPath;
    if (!root || hasSysroot(root)) return;
    const cfg = readRunnerConfig();
    if (cfg.mode !== 'ssh' || !cfg.sshHost) return;
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Linux C Quiz：同步 VM 系统头文件（首次，供本地补全）…', cancellable: false },
      () => syncSysroot(root, { host: cfg.sshHost, sshPath: cfg.sshPath }),
    );
    out.appendLine(`[sysroot] ${res.message}`);
    if (res.ok) void vscode.window.showInformationMessage(res.message);
    else void vscode.window.showWarningMessage(`VM 头文件同步失败：${res.message}（可稍后用命令「Quiz: 同步 VM 系统头文件」重试）`);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('linux-c-quiz.refresh', () => provider.refresh()),

    vscode.commands.registerCommand('linux-c-quiz.syncSysroot', async () => {
      const root = store.wsRoot?.fsPath;
      if (!root) {
        void vscode.window.showErrorMessage('请先打开一个工作区文件夹。');
        return;
      }
      const cfg = readRunnerConfig();
      if (cfg.mode !== 'ssh' || !cfg.sshHost) {
        void vscode.window.showInformationMessage('只有 quiz.runner = ssh（Windows 本地 + VM 编译）时才需要同步 VM 头文件。');
        return;
      }
      const res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: '同步 VM 系统头文件…', cancellable: false },
        () => syncSysroot(root, { host: cfg.sshHost, sshPath: cfg.sshPath }),
      );
      out.appendLine(`[sysroot] ${res.message}`);
      void (res.ok
        ? vscode.window.showInformationMessage(res.message)
        : vscode.window.showErrorMessage(`同步失败：${res.message}`));
    }),

    vscode.commands.registerCommand('linux-c-quiz.checkRunner', async () => {
      const cfg = readRunnerConfig();
      out.show(true);
      const sshBin = resolveSshBin(cfg.sshPath);
      out.appendLine(`[Runner 自检] mode=${cfg.mode} sshHost=${cfg.sshHost || '(未配置)'} sshBin=${sshBin} remoteRoot=${cfg.remoteRoot} cc=${cfg.cCompiler} timeout=${cfg.timeoutMs}ms`);

      if (cfg.mode === 'off') {
        void vscode.window.showInformationMessage('Runner 当前为 off（只作答、不运行）。要编译运行请把 quiz.runner 改成 ssh 或 local。');
        return;
      }

      if (cfg.mode === 'ssh' && !cfg.sshHost) {
        const go = await vscode.window.showWarningMessage(
          '已选择 ssh 模式，但没填 quiz.sshHost（形如 用户名@192.168.88.128）。',
          '打开设置',
        );
        if (go === '打开设置') void vscode.commands.executeCommand('workbench.action.openSettings', 'quiz.sshHost');
        return;
      }

      const remoteProbe = 'echo "user=$(whoami) host=$(hostname)"; echo "--- tools ---"; command -v gcc || echo "gcc: 缺失"; command -v make || echo "make: 缺失"; command -v gdb || echo "gdb: 缺失"; echo "--- versions ---"; gcc --version 2>/dev/null | head -1; make --version 2>/dev/null | head -1; echo "--- home ---"; echo $HOME';

      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Runner 自检…', cancellable: false },
        async () => {
          if (cfg.mode === 'ssh') {
            const r = new SshRunner(cfg.sshHost, cfg.remoteRoot, cfg.cCompiler, resolveSshBin(cfg.sshPath));
            return await r.probe(remoteProbe);
          }
          return await capture([cfg.cCompiler, '--version'], { timeoutMs: 15000 });
        },
      );

      const body = `cmd: ${result.cmd}\nexit: ${result.exitCode}${result.timedOut ? ' (超时)' : ''}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}${result.error ? `\nerror: ${result.error}` : ''}`;
      out.appendLine(body);

      const ok = result.exitCode === 0 && !result.error && !result.timedOut;
      if (cfg.mode === 'ssh') {
        const firstLine = (result.stdout || result.stderr).split('\n').find((l) => l.trim()) ?? '';
        if (ok) {
          void vscode.window.showInformationMessage(`VM 连接正常：${firstLine}（详情见「输出 → Quiz」）`, '查看输出').then((v) => {
            if (v === '查看输出') out.show(true);
          });
        } else {
          const fix = await vscode.window.showErrorMessage(
            `连不上 VM：${(result.stderr || result.error || `exit ${result.exitCode}`).split('\n')[0] ?? ''}`,
            '查看输出',
            '打开设置',
          );
          if (fix === '查看输出') out.show(true);
          if (fix === '打开设置') void vscode.commands.executeCommand('workbench.action.openSettings', 'quiz.sshHost');
        }
      } else if (ok) {
        void vscode.window.showInformationMessage(`本地编译器可用：${result.stdout.split('\n')[0]}`);
      } else {
        const go = await vscode.window.showWarningMessage(
          `本机没有 ${cfg.cCompiler}。Windows 本地做题建议把 quiz.runner 设为 ssh，用 VM 编译。`,
          '打开设置',
        );
        if (go === '打开设置') void vscode.commands.executeCommand('workbench.action.openSettings', 'quiz.runner');
      }
    }),

    vscode.commands.registerCommand('linux-c-quiz.verifyBank', async (arg?: unknown) => {
      if (!requireWs()) return;
      const target = resolvePaperFile(arg) ?? (await pickPaper(store));
      if (!target) return;
      const paper = await store.loadPaper(target);
      if (!paper) {
        void vscode.window.showErrorMessage('试卷解析失败。');
        return;
      }
      const cfg = readRunnerConfig();
      if (cfg.mode === 'off') {
        void vscode.window.showWarningMessage('Runner 为 off，无法运行用例自检（用例自检需要真的执行参考答案）。');
        return;
      }
      if (cfg.mode === 'ssh' && !cfg.sshHost) {
        void vscode.window.showWarningMessage('ssh 模式需要配置 quiz.sshHost（用户名@VM的IP）。');
        return;
      }
      const runner =
        cfg.mode === 'ssh'
          ? new SshRunner(cfg.sshHost, cfg.remoteRoot, cfg.cCompiler, resolveSshBin(cfg.sshPath))
          : new LocalRunner(cfg.cCompiler);

      out.show(true);
      out.appendLine(`[用例自检] 《${paper.paper.title}》开始（runner=${cfg.mode}）…`);
      const report = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `用例自检：《${paper.paper.title}》…`, cancellable: false },
        () =>
          verifyPaperSolutions(runner, paper, store.wsRoot!.fsPath, {
            cCompiler: cfg.cCompiler,
            cppCompiler: cfg.cppCompiler,
            timeoutMs: cfg.timeoutMs,
          }),
      );

      for (const r of report.results) {
        if (r.skipped) {
          out.appendLine(`  ${r.qid} ⏭ 跳过：${r.error}`);
        } else if (r.summary) {
          out.appendLine(`  ${r.qid} ${r.ok ? '✅' : '❌'} 参考答案通过 ${r.summary.passed}/${r.summary.total} 个用例`);
          for (const t of r.summary.tests) {
            out.appendLine(`      ${t.passed ? '✓' : '✗'} ${t.name}（exit=${t.exitCode}${t.timedOut ? ' 超时' : ''}）`);
            if (!t.passed) {
              out.appendLine(`         实际=${JSON.stringify(t.stdout.slice(0, 300))}`);
              out.appendLine(`         期望=${JSON.stringify(t.expected.slice(0, 300))}`);
            }
          }
        } else {
          out.appendLine(`  ${r.qid} ❌ ${r.error}`);
        }
      }

      const codingCount = report.results.length;
      const checked = report.results.filter((r) => !r.skipped).length;
      if (report.badTests.length === 0) {
        void vscode.window.showInformationMessage(
          `用例自检通过：${checked}/${codingCount} 道编程题完成自检，参考答案全部跑过用例，用例没有问题。`,
        );
      } else {
        const first = report.badTests[0];
        const go = await vscode.window.showWarningMessage(
          `用例自检发现 ${report.badTests.length} 个坏用例（参考答案都跑不过）。例如 ${first.qid}「${first.test}」：${first.reason.slice(0, 80)}`,
          '查看详情',
        );
        if (go === '查看详情') out.show(true);
      }
    }),

    vscode.commands.registerCommand('linux-c-quiz.openScratch', async (arg?: unknown) => {
      if (!requireWs()) return;
      const node = arg as { q?: { id?: string } } | undefined;
      const target = resolvePaperFile(arg);
      const qid = typeof node?.q?.id === 'string' ? node.q.id : undefined;
      if (!target || !qid) {
        void vscode.window.showInformationMessage('请先在答题面板中打开编程题，再点「在编辑器中打开」。');
        return;
      }
      const paper = await store.loadPaper(target);
      const q = paper?.questions.find((x) => x.id === qid);
      const info = paper && q ? scratch.ensure(paper.file, q) : undefined;
      if (!info) return;
      await ensureSysroot();
      await vscode.window.showTextDocument(vscode.Uri.file(info.entryPath), {
        viewColumn: vscode.ViewColumn.Beside,
        preview: false,
      });
    }),

    vscode.commands.registerCommand('linux-c-quiz.openWrongbook', async () => {
      if (!requireWs()) return;
      await QuizPanel.showWrongbook(context, store, provider, 'active');
    }),

    vscode.commands.registerCommand('linux-c-quiz.openWrongbookPassed', async () => {
      if (!requireWs()) return;
      await QuizPanel.showWrongbook(context, store, provider, 'passed');
    }),

    vscode.commands.registerCommand('linux-c-quiz.openPaper', async (arg?: unknown) => {
      const target = resolvePaperFile(arg) ?? (await pickPaper(store));
      if (!target) return;
      const paper = await store.loadPaper(target);
      if (paper) QuizPanel.show(context, store, provider, paper);
    }),

    vscode.commands.registerCommand('linux-c-quiz.openQuestion', async (arg?: unknown, qid?: unknown) => {
      const target = resolvePaperFile(arg);
      if (!target) return;
      const paper = await store.loadPaper(target);
      if (paper) QuizPanel.show(context, store, provider, paper, typeof qid === 'string' ? qid : undefined);
    }),

    vscode.commands.registerCommand('linux-c-quiz.deletePaper', async (arg?: unknown) => {
      if (!requireWs()) return;
      out.appendLine(`[deletePaper] 收到参数: ${describeArg(arg)}`);
      const target = resolvePaperFile(arg) ?? (await pickPaper(store));
      out.appendLine(`[deletePaper] 解析到试卷文件: ${String(target)}`);
      if (!target) return;
      const paper = await store.loadPaper(target);
      const title = paper?.paper.title ?? target;
      const answer = await vscode.window.showWarningMessage(
        `确定删除《${title}》吗？`,
        { modal: true, detail: `题库文件会移到 .quiz/trash/（可手动恢复），该卷的作答记录也会一并清除。` },
        '删除',
      );
      if (answer !== '删除') return;
      const dst = await store.deletePaper(target);
      await provider.refresh();
      void vscode.window.showInformationMessage(
        dst ? `已删除《${title}》，原文件备份在 .quiz/trash/` : '删除失败：题库文件不存在。',
      );
    }),

    vscode.commands.registerCommand('linux-c-quiz.importPaper', async () => {
      if (!requireWs()) return;
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { '试卷 (YAML/Markdown)': ['yaml', 'yml', 'md'] },
      });
      if (!uris?.[0]) return;
      await importPaperFromUri(store, uris[0]);
      provider.refresh();
    }),

    vscode.commands.registerCommand('linux-c-quiz.copyGeneratePrompt', async () => {
      const text = await readPrompt(context, store, 'generate.md');
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage('出题提示词已复制，去粘贴给 DeepSeek；拿到回复存成 .yaml/.md 后用「导入试卷」。');
    }),

    vscode.commands.registerCommand('linux-c-quiz.copyReviewPrompt', async () => {
      const text = await readPrompt(context, store, 'review.md');
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage('批改提示词已复制（批改完整请求请用「导出本卷作答」）。');
    }),

    vscode.commands.registerCommand('linux-c-quiz.exportAnswers', async () => {
      if (!requireWs()) return;
      const file = QuizPanel.currentPaperFile ?? (await pickPaper(store));
      if (!file) return;
      await exportAnswers(context, store, file);
      provider.refresh();
    }),

    vscode.commands.registerCommand('linux-c-quiz.importGrades', async () => {
      if (!requireWs()) return;
      const file = QuizPanel.currentPaperFile ?? (await pickPaper(store));
      if (!file) return;
      await importGradesFromClipboard(context, store, provider, file);
      await QuizPanel.postSummary(store);
    }),

    vscode.commands.registerCommand('linux-c-quiz.importGradesFile', async () => {
      if (!requireWs()) return;
      const file = QuizPanel.currentPaperFile ?? (await pickPaper(store));
      if (!file) return;
      await importGradesFromImportDir(store, provider, file);
      await QuizPanel.postSummary(store);
    }),

    vscode.commands.registerCommand('linux-c-quiz.reviewKnowledge', async (arg?: unknown) => {
      if (!requireWs()) return;
      const target = resolvePaperFile(arg) ?? (await pickPaper(store));
      if (!target) return;
      const paper = await store.loadPaper(target);
      if (!paper) {
        void vscode.window.showErrorMessage('试卷解析失败。');
        return;
      }
      const st = await store.loadState();
      const md = renderPaperKnowledge(paper, st.papers[target] ?? {});
      const uri = await store.writeReviewDoc(paper.paper.title, md);
      if (!uri) return;
      void vscode.window.showInformationMessage(`知识点速览已生成：${vscode.workspace.asRelativePath(uri)}`);
      await vscode.commands.executeCommand('markdown.showPreviewToSide', uri);
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('quiz')) void provider.refresh();
    }),
  );

  void provider.refresh();
}

async function pickPaper(store: Store): Promise<string | undefined> {
  const papers = await store.listPapers();
  if (papers.length === 0) {
    void vscode.window.showInformationMessage('题库为空，先执行「导入试卷」。');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    papers.map((p) => ({ label: p.paper.title, description: `${p.questions.length} 题`, file: p.file })),
    { placeHolder: '选择试卷' },
  );
  return pick?.file;
}

export function deactivate(): void {
  /* no-op */
}
