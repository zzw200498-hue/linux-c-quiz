import { useEffect, useState } from 'react';
import type { Answer, Blank, Question } from '../../shared/types';
import { normalize } from '../../shared/judge';
import { md } from '../md';

type Props = {
  q: Question;
  answer?: Answer;
  onSave: (value: string | string[] | null, correct: boolean | null) => void;
};

function accepted(b: Blank): string[] {
  return [b.answer, ...(b.alt ?? [])];
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

/** 填空题：题干 ____N____ 处渲染行内输入框；离开输入框或点按钮即保存，交卷后显示对错 */
export function FillView({ q, answer, onSave }: Props) {
  const judged = answer?.correct != null;
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

  const commit = () => {
    const clean = vals.map((v) => v.trim());
    if (clean.every((v) => !v)) return;
    onSave(clean, null);
    setDirty(false);
    setSavedAt(Date.now());
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
            <button className="btn primary" disabled={vals.every((v) => !v.trim())} onClick={commit}>
              {savedAt ? '更新答案' : '保存答案'}
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
