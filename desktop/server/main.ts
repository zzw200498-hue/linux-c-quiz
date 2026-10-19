import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { resolveConfig } from './config';
import { NodeStore } from './store';
import { NodeScratch } from './scratch';
import { SshRunner, resolveSshBin } from '../../src/runner/ssh';
import { runQuestionTests } from '../../src/core/tester';
import { judge, isObjective, isEmptyAnswer } from '../../src/shared/judge';
import type { Runner } from '../../src/runner/types';

// Windows 上从 Git-Bash 启动时 HOME 是 MSYS 路径（/c/Users/xxx），系统 OpenSSH 找不到 ~/.ssh 里的私钥。
// VSCode 版没这个问题（宿主环境 HOME 正确），桌面端在这里兜一下。
if (process.platform === 'win32' && process.env.USERPROFILE) {
  process.env.HOME = process.env.USERPROFILE;
}

const cfg = resolveConfig();
const store = new NodeStore(cfg);
const scratch = new NodeScratch(cfg);

const PORT = Number(process.env.QUIZ_PORT ?? 5733);

/* ---------- Runner：与 VSCode 版同一套 ssh 逻辑 ---------- */
function makeRunner(): Runner | { kind: 'off'; describe(): string } {
  if (cfg.runner === 'off') {
    return { kind: 'off' as const, describe: () => 'off（只作答不运行）' };
  }
  if (cfg.runner === 'ssh') {
    if (!cfg.sshHost) throw new Error('没配置 quiz.sshHost（用户名@VM的IP）');
    return new SshRunner(cfg.sshHost, cfg.remoteRoot, cfg.cCompiler, resolveSshBin(cfg.sshBin || undefined));
  }
  // local：本机直接跑（Linux 有效；Windows 无 gcc 会被 tester 给出提示）
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LocalRunner } = require('../../src/runner/local') as typeof import('../../src/runner/local');
  return new LocalRunner(cfg.cCompiler, cfg.cppCompiler);
}

/* ---------- HTTP 基础 ---------- */
function json(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function runnerInfo() {
  const hasSysroot = fs.existsSync(cfg.sysrootDir);
  return {
    runner: cfg.runner,
    sshHost: cfg.sshHost,
    compiler: cfg.cCompiler,
    sysroot: hasSysroot,
    describe: cfg.runner === 'ssh' ? (cfg.sshHost ? `ssh ${cfg.sshHost} (${cfg.cCompiler})` : 'ssh 未配置主机') : cfg.runner,
  };
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function serveStatic(urlPath: string, res: http.ServerResponse): boolean {
  const webDir = path.resolve(__dirname, '..', 'web');
  const distDir = path.resolve(__dirname, '..', 'dist');
  const rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  const candidates = [
    path.join(webDir, rel),
    path.join(distDir, rel),
  ];
  for (const file of candidates) {
    if (!file.startsWith(webDir) && !file.startsWith(distDir)) continue;
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) continue;
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
    return true;
  }
  return false;
}

/* ---------- 路由 ---------- */
async function handleApi(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const p = url.pathname;
  const q = (k: string) => url.searchParams.get(k) ?? '';

  if (p === '/api/config') {
    return json(res, { ...runnerInfo(), wsRoot: cfg.wsRoot, port: PORT });
  }

  if (p === '/api/papers') {
    await store.syncWrongbook();
    const st = store.loadState();
    const papers = store.listPapers();
    const list = papers.map((p2) => {
      const answers = st.papers[p2.file] ?? {};
      const n = p2.questions.length;
      const done = p2.questions.filter((x) => !isEmptyAnswer(answers[x.id]?.value)).length;
      const summary = st.summaries[p2.file] ?? null;
      return {
        file: p2.file,
        title: p2.paper.title,
        topics: p2.paper.topics ?? [],
        date: p2.paper.date ?? '',
        count: n,
        answered: done,
        percent: n > 0 ? Math.round((done / n) * 100) : 0,
        summary,
      };
    });
    return json(res, { papers: list, stats: store.stats() });
  }

  if (p === '/api/import' && req.method === 'POST') {
    const b = await readBody(req);
    const r = store.importPaper(String(b.text ?? ''));
    return json(res, r);
  }

  if (p === '/api/prompt') {
    // 出题提示词：界面上一键复制，粘给 AI 出题
    try {
      return json(res, { text: fs.readFileSync(cfg.promptFile, 'utf8') });
    } catch {
      return json(res, { text: '', error: `找不到提示词文件：${cfg.promptFile}` });
    }
  }

  if (p === '/api/paper') {
    const file = q('file');
    const paper = store.loadPaper(file);
    if (!paper) return json(res, { error: '试卷不存在' }, 404);
    const st = store.loadState();
    return json(res, {
      file: paper.file,
      title: paper.paper.title,
      topics: paper.paper.topics ?? [],
      questions: paper.questions,
      answers: st.papers[file] ?? {},
      summary: st.summaries[file] ?? null,
    });
  }

  if (p === '/api/answer' && req.method === 'POST') {
    const b = await readBody(req);
    // 练习模式（随机刷题 / 错题本）重做旧题时：只更新作答内容，保留原卷的历史判定与批改
    const keep = b.keepJudgement === true;
    const prev = keep ? store.loadState().papers[b.file]?.[b.qid] : undefined;
    await store.saveAnswer(b.file, b.qid, {
      value: b.value ?? null,
      correct: keep ? (prev?.correct ?? null) : (b.correct ?? null),
      ...(keep && prev?.grade ? { grade: prev.grade } : {}),
    });
    return json(res, { ok: true });
  }

  if (p === '/api/submit' && req.method === 'POST') {
    const b = await readBody(req);
    const r = await store.submitPaper(b.file);
    return json(res, r);
  }

  if (p === '/api/clear' && req.method === 'POST') {
    const b = await readBody(req);
    await store.clearJudgement(b.file);
    return json(res, { ok: true });
  }

  if (p === '/api/wrongbook') {
    await store.syncWrongbook();
    const kind = (q('kind') === 'passed' ? 'passed' : 'active') as 'active' | 'passed';
    const entries = store.wrongbookEntries(kind);
    const cache = new Map<string, ReturnType<NodeStore['loadPaper']>>();
    const items = entries.map((e) => {
      let paper = cache.get(e.paper);
      if (paper === undefined) {
        paper = store.loadPaper(e.paper);
        cache.set(e.paper, paper);
      }
      const qq = paper?.questions.find((x) => x.id === e.qid);
      return {
        key: `${e.paper}#${e.qid}`,
        paperFile: e.paper,
        qid: e.qid,
        type: qq?.type ?? 'short',
        stem: (qq?.stem ?? '').slice(0, 120),
        streak: e.streak,
        tries: e.tries,
        graduatedAt: e.graduatedAt,
      };
    });
    return json(res, { kind, items });
  }

  if (p === '/api/random') {
    const set = store.randomSet(15);
    const st = store.loadState();
    const answers: Record<string, unknown> = {};
    for (const panelId of Object.keys(set.source)) {
      const src = set.source[panelId];
      answers[panelId] = st.papers[src.paper]?.[src.qid] ?? null;
    }
    return json(res, { ...set, answers });
  }

  if (p === '/api/practice' && req.method === 'POST') {
    const b = await readBody(req);
    const entry = await store.recordWrongbookPractice(b.paper, b.qid, b.ok === null ? null : b.ok === true);
    return json(res, { entry });
  }

  if (p === '/api/selfgrade' && req.method === 'POST') {
    const b = await readBody(req);
    const r = await store.saveSelfGrade(b.paper, b.qid, Number(b.score));
    return json(res, r);
  }

  if (p === '/api/stats') {
    return json(res, store.stats());
  }

  if (p === '/api/code') {
    const file = q('file');
    const qid = q('qid');
    const paper = store.loadPaper(file);
    const question = paper?.questions.find((x) => x.id === qid);
    if (!paper || !question) return json(res, { error: '题目不存在' }, 404);
    const st = store.loadState();
    const saved = st.papers[file]?.[qid]?.value;
    const fallback = typeof saved === 'string' ? saved : Array.isArray(saved) ? saved.join('\n') : '';
    const info = scratch.read(file, question, fallback || question.templateCode || '');
    return json(res, {
      code: info.code,
      entryName: info.entryName,
      lang: info.lang,
      dir: info.dir,
      readonly: !isObjective(question) && question.type !== 'coding',
    });
  }

  if (p === '/api/code' && req.method === 'POST') {
    const b = await readBody(req);
    const paper = store.loadPaper(b.file);
    const question = paper?.questions.find((x) => x.id === b.qid);
    if (!paper || !question) return json(res, { error: '题目不存在' }, 404);
    scratch.write(b.file, question, String(b.code ?? ''));
    const keep = b.keepJudgement === true;
    const prev = keep ? store.loadState().papers[b.file]?.[b.qid] : undefined;
    await store.saveAnswer(b.file, b.qid, {
      value: String(b.code ?? ''),
      correct: keep ? (prev?.correct ?? null) : null,
      ...(keep && prev?.grade ? { grade: prev.grade } : {}),
    });
    return json(res, { ok: true });
  }

  if (p === '/api/run' && req.method === 'POST') {
    const b = await readBody(req);
    const paper = store.loadPaper(b.file);
    const question = paper?.questions.find((x) => x.id === b.qid);
    if (!paper || !question) return json(res, { error: '题目不存在' }, 404);
    // 练习模式：保留原卷历史判定（重做不该把以前的成绩抹掉）
    const keep = b.keepJudgement === true;
    const prevKeep = keep ? store.loadState().papers[b.file]?.[b.qid] : undefined;
    if (typeof b.code === 'string') {
      scratch.write(b.file, question, b.code);
      await store.saveAnswer(b.file, b.qid, {
        value: b.code,
        correct: keep ? (prevKeep?.correct ?? null) : null,
        ...(keep && prevKeep?.grade ? { grade: prevKeep.grade } : {}),
      });
    }
    const info = scratch.ensure(b.file, question);
    try {
      const runner = makeRunner();
      const summary = await runQuestionTests(runner, question, info.dir, {
        cCompiler: cfg.cCompiler,
        cppCompiler: cfg.cppCompiler,
        timeoutMs: cfg.timeoutMs,
      });
      await store.saveAnswer(b.file, b.qid, {
        value: String(b.code ?? ''),
        correct: keep ? (prevKeep?.correct ?? null) : null,
        ...(keep && prevKeep?.grade ? { grade: prevKeep.grade } : {}),
        lastRun: { passed: summary.passed, total: summary.total, ts: Date.now() },
      });
      return json(res, summary);
    } catch (e) {
      return json(res, { error: String((e as Error).message ?? e) }, 200);
    }
  }

  if (p === '/api/ssh') {
    if (cfg.runner !== 'ssh' || !cfg.sshHost) return json(res, { ok: false, msg: '当前不是 ssh 模式' });
    try {
      const runner = makeRunner() as SshRunner;
      const started = Date.now();
      const r = await runner.probe('echo QUIZ_OK && gcc --version | head -1');
      return json(res, {
        ok: /QUIZ_OK/.test(r.stdout),
        ms: Date.now() - started,
        stdout: r.stdout.trim().slice(0, 400),
        stderr: r.stderr?.trim().slice(0, 300) ?? '',
      });
    } catch (e) {
      return json(res, { ok: false, msg: String((e as Error).message ?? e) });
    }
  }

  if (p === '/api/judgeone' && req.method === 'POST') {
    const b = await readBody(req);
    const paper = store.loadPaper(b.file);
    const question = paper?.questions.find((x) => x.id === b.qid);
    if (!paper || !question) return json(res, { error: '题目不存在' }, 404);
    return json(res, { correct: judge(question, b.value ?? null) });
  }

  return json(res, { error: '未知接口 ' + p }, 404);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(url, req, res).catch((e) => {
      console.error('[desktop] API 出错', e);
      json(res, { error: String((e as Error).message ?? e) }, 500);
    });
    return;
  }
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!serveStatic(pathname, res)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Linux C 题库 · 桌面端已启动`);
  console.log(`  http://127.0.0.1:${PORT}`);
  console.log(`  工作区：${cfg.wsRoot}`);
  console.log(`  Runner：${runnerInfo().describe}${runnerInfo().sysroot ? '（sysroot 已就绪）' : ''}\n`);
});
