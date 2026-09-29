import { useEffect, useState } from 'react';
import type { Answer, Question } from '../../shared/types';
import { onHostMessage, post } from '../vscode';
import { fmtTime } from './FillView';

type Props = {
  q: Question;
  answer?: Answer;
  onSave: (value: string | null, correct: null) => void;
};

/** short / rewrite / coding 三类主观题共用 */
export function SubjectiveView({ q, answer, onSave }: Props) {
  const [text, setText] = useState('');
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [showRef, setShowRef] = useState(false);

  useEffect(() => {
    const v = answer?.value;
    setText(typeof v === 'string' ? v : '');
    setDirty(false);
    setShowRef(false);
    setSavedAt(typeof v === 'string' && v.length > 0 ? (answer?.ts ?? Date.now()) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.id]);

  useEffect(() => {
    return onHostMessage((m) => {
      if (m.type === 'scratchSaved' && m.qid === q.id) {
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

  return (
    <div className="subjective">
      {(q.originCode || q.templateCode) && (
        <pre className="codeblock">
          <code>{q.originCode ?? q.templateCode}</code>
        </pre>
      )}

      {q.tests && q.tests.length > 0 && (
        <div className="tests">
          <b>测试用例（v0.2 支持本地运行）：</b>
          <ul>
            {q.tests.map((t, i) => (
              <li key={i}>
                {t.name || `用例${i + 1}`}
                {t.match === 'contains' ? '（包含匹配）' : ''}
              </li>
            ))}
          </ul>
        </div>
      )}

      <textarea
        rows={q.type === 'coding' ? 14 : 8}
        className="code-input"
        spellCheck={false}
        value={text}
        placeholder={
          q.type === 'coding'
            ? '在此粘贴/编写你的完整代码作答（v0.2 起可一键在 scratch 目录编译运行）'
            : '在此作答……写代码时可点「在编辑器中打开」用 VSCode 原生编辑器（自动补全 / 语法高亮）'
        }
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
        <button
          className="btn"
          title="在 scratch 目录用 VSCode 真实编辑器作答；保存即回写作答（含 C/Makefile 语法高亮与补全）"
          onClick={() => post({ type: 'openScratch', qid: q.id, code: text })}
        >
          在编辑器中打开
        </button>
        {savedAt && !dirty && <span className="saved-hint ok">✓ 已保存 {fmtTime(savedAt)}</span>}
        {dirty && savedAt && <span className="saved-hint dirty">有未保存修改</span>}
        {saved && (
          <button className="btn ghost" onClick={() => setShowRef((s) => !s)}>
            {showRef ? '隐藏参考答案' : '查看参考答案'}
          </button>
        )}
        {!savedAt && (
          <span className="hint">
            保存后可查看参考答案；整卷完成后用命令「导出本卷作答」交给 DeepSeek 批改。
          </span>
        )}
      </div>

      {showRef && (
        <div className="reference">
          {q.referenceAnswer && (
            <>
              <b>参考答案</b>
              <pre className="ref-text">{q.referenceAnswer}</pre>
            </>
          )}
          {q.referenceCode && (
            <>
              <b>参考代码</b>
              <pre className="codeblock">
                <code>{q.referenceCode}</code>
              </pre>
            </>
          )}
          {q.rubrics && q.rubrics.length > 0 && (
            <>
              <b>评分要点</b>
              <ul>
                {q.rubrics.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </>
          )}
          {q.explain && (
            <>
              <b>解析</b>
              <div>{q.explain}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
