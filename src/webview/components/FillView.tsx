import { useEffect, useState } from 'react';
import type { Answer, Blank, Question } from '../../shared/types';
import { normalize } from '../../shared/judge';
import { md } from '../md';

type Props = {
  q: Question;
  answer?: Answer;
  /** 只保存作答，不做判定（输入框失焦时走这条） */
  onSave: (value: string | string[] | null, correct: boolean | null) => void;
  /** 错题本/随机刷题模式：点「提交并判定」才调用，用于结算连对次数 */
  onCommit?: (value: string | string[] | null) => void;
  commitLabel?: string;
  /** 是否显示「已判定」状态（覆盖 answer.correct）；错题本刷题传 false，避免沿用原卷判定、一打开就剧透 */
  judgedOverride?: boolean;
};

function accepted(b: Blank): string[] {
  return [b.answer, ...(b.alt ?? [])];
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** 填空题：题干 ____N____ 处渲染行内输入框；离开输入框或点按钮即保存，交卷后显示对错 */
export function FillView({ q, answer, onSave, onCommit, commitLabel, judgedOverride }: Props) {
  const judged = judgedOverride ?? (answer?.correct != null);
  const blanks = q.blanks ?? [];
  const [vals, setVals] = useState<string[]>(blanks.map(() => ''));
  const [dirty, setDirty] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    const v = answer?.value;
    setVals(Array.isArray(v) ? [...v] : typeof v === 'string' && v ? [v] : blanks.map(() => ''));
    setDirty(false);
    setSavedAt(answer?.value != null ? (answer?.ts ?? Date.now()) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.id]);

  const clean = () => vals.map((v) => v.trim());

  /** 失焦 / 保存按钮：只保存作答（多空填空题填第一空时不判定，否则必然判错） */
  const commit = () => {
    const c = clean();
    if (c.every((v) => !v)) return;
    onSave(c, null);
    setDirty(false);
    setSavedAt(Date.now());
  };

  /** 错题本模式：点「提交并判定」才结算连对 */
  const submit = () => {
    const c = clean();
    if (c.every((v) => !v)) return;
    if (onCommit) onCommit(c);
    else commit();
  };

  const parts = q.stem.split(/(____\d+____)/);

  return (
    <div>
      <div className="stem fill-stem">
        {parts.map((p, i) => {
          const m = /^____(\d+)____$/.exec(p);
          if (!m) return <span key={i} dangerouslySetInnerHTML={{ __html: md.renderInline(p) }} />;
          const bi = Number(m[1]) - 1;
          const b = blanks[bi];
          const ok =
            judged && b ? accepted(b).some((c) => normalize(c) === normalize(vals[bi] ?? '')) : false;
          return (
            <span key={i} className="blank-wrap">
              <input
                className="blank-input"
                type="text"
                value={vals[bi] ?? ''}
                disabled={judged}
                placeholder={`空${bi + 1}`}
                onChange={(e) => {
                  const v = e.target.value;
                  setVals((old) => old.map((x, j) => (j === bi ? v : x)));
                  setDirty(true);
                }}
                onBlur={() => {
                  if (dirty) commit();
                }}
              />
              {judged && b && (
                <span className={`blank-mark ${ok ? 'ok' : 'bad'}`}>
                  {ok ? '✓' : `✗ 参考：${accepted(b).join(' / ')}`}
                </span>
              )}
            </span>
          );
        })}
      </div>

      <div className="subj-actions">
        {!judged ? (
          <>
            <button className="btn primary" disabled={vals.every((v) => !v.trim())} onClick={submit}>
              {commitLabel ?? (savedAt ? '更新答案' : '保存答案')}
            </button>
            {savedAt && !dirty && <span className="saved-hint ok">✓ 已保存 {fmtTime(savedAt)}</span>}
            {dirty && savedAt && <span className="saved-hint dirty">有未保存修改</span>}
          </>
        ) : (
          <button
            className="btn ghost"
            onClick={() => {
              setVals(blanks.map(() => ''));
              setDirty(false);
              setSavedAt(null);
              onSave(null, null);
            }}
          >
            重做本题
          </button>
        )}
      </div>
    </div>
  );
}
