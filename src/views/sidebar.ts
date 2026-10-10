import * as vscode from 'vscode';
import type { Answer, PaperFile, PaperSummary, Question } from '../shared/types';
import type { WrongbookKind } from '../shared/wrongbook';
import { TYPE_LABEL } from '../shared/types';
import {
  hasKnowledge,
  knowledgeState,
  renderTooltip,
} from '../shared/knowledge';
import type { Store } from '../core/store';

/** 侧栏悬停提示内容策略 */
export type TooltipMode = 'judged' | 'answered' | 'always' | 'off';

function tooltipMode(): TooltipMode {
  const v = vscode.workspace.getConfiguration('quiz').get<string>('knowledgeTooltip', 'answered');
  return v === 'judged' || v === 'always' || v === 'off' ? v : 'answered';
}

export class PaperNode {
  constructor(public paper: PaperFile) {}
}

export class QuestionNode {
  constructor(
    public paperFile: PaperFile,
    public q: Question,
    public index: number,
    public answer?: Answer,
  ) {}
}

/** 错题本节点：kind=active 置顶（待攻克），kind=passed 置尾（已过关） */
export class WrongbookNode {
  constructor(
    public kind: WrongbookKind,
    public count: number,
    public attempts: number,
  ) {}
}

export type TreeNode = PaperNode | QuestionNode | WrongbookNode;

export class PapersProvider implements vscode.TreeDataProvider<TreeNode> {
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private state: Record<string, Record<string, Answer>> = {};
  private summaries: Record<string, PaperSummary> = {};
  private wrongActive = 0;
  private wrongPassed = 0;

  constructor(private store: Store) {}

  async refresh(): Promise<void> {
    await this.store.syncWrongbook();
    const st = await this.store.loadState();
    this.state = st.papers;
    this.summaries = st.summaries;
    this.wrongActive = Object.values(st.wrongbook).filter((e) => !e.passed).length;
    this.wrongPassed = Object.values(st.wrongbook).filter((e) => e.passed).length;
    this.emitter.fire();
  }

  getTreeItem(el: TreeNode): vscode.TreeItem {
    if (el instanceof WrongbookNode) {
      const active = el.kind === 'active';
      const label = active ? `错题本 · 待攻克（${el.count}）` : `已过关错题（${el.count}）`;
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(
        active ? 'flame' : 'check',
        new vscode.ThemeColor(active ? 'charts.red' : 'charts.green'),
      );
      item.description = active ? '随机刷题' : '连对 3 次';
      item.tooltip = new vscode.MarkdownString(
        [
          active ? `**错题本 · 待攻克**` : `**已过关错题**`,
          '',
          active
            ? `收录规则：客观题判错、主观题被批改判为「错」或「部分正确」的题都会进来。`
            : `每题在错题本里连续答对 3 次即毕业，移到这里。`,
          `当前 ${el.count} 题${el.attempts > 0 ? `，累计练习 ${el.attempts} 次` : ''}。`,
          '',
          active ? '点开按随机顺序刷题：客观题答完即判；主观题提交后需批改（导入批改结果后计入连对次数）。' : '点开可以继续抽查；一旦答错立刻退回「待攻克」并清零连对次数。',
        ].join('\n'),
      );
      item.contextValue = active ? 'wrongbook-active' : 'wrongbook-passed';
      item.command = {
        command: active ? 'linux-c-quiz.openWrongbook' : 'linux-c-quiz.openWrongbookPassed',
        title: active ? '打开错题本刷题' : '查看已过关错题',
      };
      return item;
    }

    if (el instanceof PaperNode) {
      const answers = this.state[el.paper.file] ?? {};
      const total = el.paper.questions.length;
      const answered = el.paper.questions.filter((q) => answers[q.id]?.value != null).length;
      const ratio = total > 0 ? answered / total : 0;
      // 默认收起，保持侧栏紧凑；完成度一眼可见
      const item = new vscode.TreeItem(el.paper.paper.title, vscode.TreeItemCollapsibleState.Collapsed);
      const rep = this.summaries[el.paper.file];
      item.tooltip = new vscode.MarkdownString(
        [
          `**${el.paper.paper.title}**`,
          '',
          `进度：${answered}/${total} 已答（${Math.round(ratio * 100)}%）`,
          rep && rep.judgedCount > 0
            ? `成绩：**${rep.totalScore} 分**（全对 ${rep.verdictCounts.correct} · 部分 ${rep.verdictCounts.partial} · 错 ${rep.verdictCounts.wrong}）`
            : '',
          el.paper.paper.topics?.length ? `主题：${el.paper.paper.topics.join(' / ')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
      // 左侧完成度标记：≥80% 绿，60~79% 黄，1~59% 红，没做不标记（保留书本图标）
      if (answered > 0) {
        const color = ratio >= 0.8 ? 'charts.green' : ratio >= 0.6 ? 'charts.yellow' : 'charts.red';
        item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(color));
      } else {
        item.iconPath = new vscode.ThemeIcon('book');
      }
      item.contextValue = 'paper';
      item.command = {
        command: 'linux-c-quiz.openPaper',
        title: '打开试卷',
        arguments: [el.paper.file],
      };
      return item;
    }

    const { q, index } = el;
    const a = el.answer;
    let icon = 'circle-large-outline';
    let status = '未作答';
    if (a?.value != null) {
      if (a.grade) {
        icon = a.grade.verdict === 'correct' ? 'pass' : a.grade.verdict === 'wrong' ? 'error' : 'pencil';
        status = `${a.grade.score} 分 · ${a.grade.verdict}`;
      } else if (q.type === 'coding' && a.lastRun && a.lastRun.total > 0) {
        icon = a.lastRun.passed === a.lastRun.total ? 'pass' : 'pencil';
        status = `用例 ${a.lastRun.passed}/${a.lastRun.total}`;
      } else if (a.correct === true) {
        icon = 'pass';
        status = '正确';
      } else if (a.correct === false) {
        icon = 'error';
        status = '错误';
      } else {
        icon = 'circle-filled';
        status = q.type === 'single' || q.type === 'multi' || q.type === 'fill' ? '已答' : '待批改';
      }
    }
    const item = new vscode.TreeItem(
      `${String(index + 1).padStart(2, '0')} · ${TYPE_LABEL[q.type]}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.description = status;
    item.tooltip = buildQuestionTooltip(q, a, index);
    item.iconPath = new vscode.ThemeIcon(icon);
    item.contextValue = q.type === 'coding' ? 'question-coding' : 'question';
    item.command = {
      command: 'linux-c-quiz.openQuestion',
      title: '打开题目',
      arguments: [el.paperFile.file, q.id],
    };
    return item;
  }

  async getChildren(el?: TreeNode): Promise<TreeNode[]> {
    if (!el) {
      const papers = await this.store.listPapers();
      const st = await this.store.loadState();
      const entries = Object.values(st.wrongbook);
      const activeCount = entries.filter((e) => !e.passed).length;
      const passedCount = entries.filter((e) => e.passed).length;
      const activeTries = entries.filter((e) => !e.passed).reduce((s, e) => s + e.tries, 0);
      // 待攻克置顶、已过关置尾
      return [
        new WrongbookNode('active', activeCount, activeTries),
        ...papers.map((p) => new PaperNode(p)),
        new WrongbookNode('passed', passedCount, 0),
      ];
    }
    if (el instanceof PaperNode) {
      const answers = this.state[el.paper.file] ?? {};
      return el.paper.questions.map((q, i) => new QuestionNode(el.paper, q, i, answers[q.id]));
    }
    return [];
  }
}

/**
 * 悬停提示：默认为已判定 / 已批改的题目显示知识点（正确答案、解析、参考答案、要点），
 * 未判定时只显示题干，避免做题过程中剧透。
 */
function buildQuestionTooltip(q: Question, a: Answer | undefined, index: number): vscode.MarkdownString {
  const mode = tooltipMode();
  const state = knowledgeState(a);
  let show = false;
  if (mode !== 'off' && hasKnowledge(q)) {
    if (mode === 'always') show = true;
    else if (mode === 'answered') show = state !== 'none';
    else show = state === 'judged';
  }
  if (!show) return new vscode.MarkdownString(`**${q.stem.slice(0, 200)}**`);
  const md = new vscode.MarkdownString(renderTooltip(q, a, index));
  md.supportThemeIcons = false;
  return md;
}
