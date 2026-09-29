你是阅卷老师。下面是练习卷《{{PAPER_TITLE}}》的题目、参考答案与我的作答。
请逐题批改，只输出一个 ```yaml 代码块，格式如下，不要输出其他任何内容：

```yaml
grades:
  q01:
    verdict: correct        # correct / partial / wrong
    score: 100              # 0-100 整数
    comment: "一句话点评，指出我错在哪"
    correct_answer: "若我答错，给出正确答案或关键代码"
    missed_points: ["我漏掉的评分要点"]
  q02:
    verdict: wrong
    score: 30
    comment: "…"
    correct_answer: "…"
    missed_points: []
```

要求：
1. 必须覆盖卷中每一道题，id 与原卷一致（q01、q02……）；
2. 客观题若我已答对，comment 写"自动判定正确"即可；
3. 简答/改写/编程题按评分要点逐条对照，partial 表示部分正确；
4. 代码题重点看：正确性、资源泄漏（fd/内存）、错误处理、边界条件。

=== 题目与作答 ===
