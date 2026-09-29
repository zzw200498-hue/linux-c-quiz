import { useEffect, useState } from 'react';
import type { Answer, Question, RunSummary } from '../../shared/types';
import { onHostMessage, post } from '../vscode';
import { fmtTime } from './FillView';

type Props = {
  q: Question;
  answer?: Answer;
  onSave: (value: string | null, correct: null) => void;
};

/** 编程题：Webview 快速编辑 + 一键在真实编辑器打开 + 编译运行用例比对 */
export function CodingView({ q, answer, onSave }: Props) {
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunSummary | undefined>();
  const [showTemplate, setShowTemplate] = useState(false);

  useEffect(() => {
    const v = answer?.value;
    setText(typeof v === 'string' ? v : '');
    setDirty(false);
    setRunning(false);
    setResult(undefined);
    setShowTemplate(false);
    setSavedAt(typeof v === 'string' && v.length > 0 ? (answer?.ts ?? Date.now()) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.id]);

  useEffect(() => {
    return onHostMessage((m) => {
      if (m.type === 'runResults' && m.qid === q.id) {
        setRunning(false);
        setResult(m.data);
      } else if (m.type === 'scratchSaved' && m.qid === q.id) {
        // 用户在真实编辑器里保存了 → 同步回 Webview
        setText(m.code);
        setDirty(false);
        setSavedAt(Date.now());
      }
    });
  }, [q.id]);

  const commit = () => {
    if (!text.trim()) return;
    onSave(text, null);
    setDirty(false);
    setSavedAt(Date.now());
  };

  const saved = typeof answer?.value === 'string' && answer.value.length > 0;
  const fileNames = Object.keys(q.files ?? {});

  return (
    <div className="coding">
      {q.templateCode && (
        <details className="template" open={showTemplate} onToggle={(e) => setShowTemplate((e.currentTarget as HTMLDetailsElement).open)}>
          <summary>题目模板代码</summary>
          <pre className="codeblock">
            <code>{q.templateCode}</code>
          </pre>
        </details>
      )}

      {fileNames.length > 0 && (
        <div className="hint">配套文件（自动生成到 scratch 目录）：{fileNames.join('、')}</div>
      )}

      {q.tests && q.tests.length > 0 && (
        <div className="tests">
          <b>测试用例：</b>
          <ul>
            {q.tests.map((t, i) => (
              <li key={i}>
                {t.name || `用例${i + 1}`}
                {t.args.length > 0 ? `（${t.args.join(' ')}）` : ''}
                {t.match === 'contains' ? '（包含匹配）' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <textarea
        rows={14}
        className="code-input"
        spellCheck={false}
        value={text}
        placeholder={'在此编写完整代码作答；重度编辑点「在编辑器中打开」用 VSCode 原生编辑器（补全 / 调试）'}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
        }}
        onBlur={() => {
          if (dirty) commit();
        }}
      />

      <div className="subj-actions">
        <button className="btn primary" disabled={!text.trim()} onClick={commit}>
          {savedAt ? '更新作答' : '保存作答'}
        </button>
        <button className="btn" onClick={() => post({ type: 'openScratch', qid: q.id, code: text })}>
          在编辑器中打开
        </button>
        <button
          className="btn primary"
          disabled={running}
          onClick={() => {
            if (text.trim() && dirty) commit();
            setRunning(true);
            post({ type: 'runTests', qid: q.id, code: text });
          }}
        >
          {running ? '运行中…' : '▶ 编译运行'}
        </button>
        {savedAt && !dirty && <span className="saved-hint ok">✓ 已保存 {fmtTime(savedAt)}</span>}
        {dirty && savedAt && <span className="saved-hint dirty">有未保存修改</span>}
      </div>

      {running && <div className="run-note">正在编译运行（可在设置里调 quiz.runTimeoutSec 超时）…</div>}

      {!result && answer?.lastRun && (
        <div className="run-note">
          上次运行：{answer.lastRun.passed}/{answer.lastRun.total} 用例通过
          {answer.lastRun.ts ? `（${fmtTime(answer.lastRun.ts)}）` : ''}
        </div>
      )}

      {result && (
        <div className="runpanel">
          <div className="run-summary">
            环境：<code>{result.env}</code>
            {result.total > 0 && (
              <span className={result.passed === result.total ? 'ok' : 'bad'}>
                　·　通过 <b>{result.passed}</b>/{result.total}
              </span>
            )}
          </div>

          {result.error && <div className="run-error">{result.error}</div>}

          {!result.error && result.total > 0 && (
            <div className={`run-verdict ${result.passed === result.total ? 'ok' : 'bad'}`}>
              {result.passed === result.total
                ? `✅ 全部 ${result.total} 个用例通过`
                : `程序编译成功、能运行，但用例 ${result.passed}/${result.total} 未通过——逐条对比下面的“实际输出”和“期望输出”`}
            </div>
          )}

          {result.compile && (
            <div className={`run-compile ${result.compile.ok ? 'ok' : 'bad'}`}>
              <div className="run-cmd">$ {result.compile.cmd}</div>
              {result.compile.ok ? (
                <span className="ok">✓ 编译通过</span>
              ) : (
                <pre className="out err">{result.compile.output || '（无输出）'}</pre>
              )}
            </div>
          )}

          {result.tests.map((t, i) => (
            <div key={i} className={`test ${t.passed ? 'pass' : 'fail'}`}>
              <div className="test-head">
                <span className={`badge ${t.passed ? 'ok' : 'bad'}`}>{t.passed ? '✓ 通过' : '✗ 未通过'}</span>
                <b>{t.name}</b>
                <span className="test-meta">
                  {t.durationMs}ms
                  {t.timedOut ? ' · 超时被终止' : ''}
                  {t.exitCode != null ? ` · exit ${t.exitCode}` : ''}
                </span>
              </div>
              <div className="run-cmd">$ {t.cmd}</div>
              {t.stdout ? (
                <pre className="out">{t.stdout.slice(0, 2000)}</pre>
              ) : (
                !t.passed && <div className="hint">实际输出为空——程序没有往 stdout 打印任何内容</div>
              )}
              {t.stderr && <pre className="out err">{t.stderr.slice(0, 2000)}</pre>}
              {!t.passed && t.expected && (
                <div className="expected">
                  <b>期望输出</b>
                  <pre className="out">{t.expected.slice(0, 1000)}</pre>
                </div>
              )}
              {t.fileChecks && t.fileChecks.length > 0 && (
                <div className="expected">
                  <b>文件检查</b>
                  {t.fileChecks.map((c) => (
                    <div key={c.file} className={c.ok ? 'ok' : 'bad'}>
                      {c.ok ? '✓' : '✗'} <code>{c.file}</code>
                      {c.ok ? (c.present ? ' 存在' : ' 已删除') : c.present ? ' 仍存在（应删除）' : ' 未生成（应存在）'}
                    </div>
                  ))}
                </div>
              )}
              {t.error && <div className="run-error">{t.error}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
