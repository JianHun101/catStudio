---
type: lesson
date: 2026-09-23
status: proposed
evidence:
  - kind: file
    ref: scripts/eval/rerank-offline-ab.mjs
  - kind: file
    ref: scripts/eval/rerank-offline-ab.test.js
  - kind: commit
    ref: ab4a193f
---

# 打分模型别走分类 pipeline：信号会被整条吃掉，而一切看起来正常

## 撞出来的场景

要验一个**打分模型**（reranker 这类只吐一个相关性数值的模型）能不能分好坏。按最省事的写法，用了

```
pipeline('text-classification', <模型>)
```

## 现象

喂一对**已知相关**、一对**已知不相关**的输入进去，两边得分**都是 1.0**。

不报错、不告警、不抛异常，返回结构完全合法，所有探针全绿。

## 机制

`text-classification` 这个任务名是给**分类模型**准备的（输出一串类别概率，内部走 softmax）。而打分模型的输出是**单值**——softmax 在长度 1 的向量上恒等于 `exp(x)/exp(x) = 1`。分数被 pipeline 这一层吃干净了。

后果不是"读数差一点"，是**读数与输入无关**：

- 重排前后顺序一动不动 ⇒ 实验臂读数与基线**一模一样**
- 报告据此得出"重排无效"的结论 ⇒ **票被关错**
- 全程**没有任何一处报错**——这正是它危险的地方

## 正解

打分模型走 `AutoModelForSequenceClassification` 直接加载 + **显式 sigmoid**。同一模型实测可分：相关 **0.9979** / 不相关 **0.0000889**。

## 可复用的动作

凡"验一个模型能不能区分好坏"的活，验收项里**必须有一条非退化断言**：

> 拿一对已知相关、一对已知不相关的输入，断言两者分数**不相等**，且相关 > 0.5 > 不相关。

不满足 ⇒ 判**测量失败**，不是判**模型无效**。这两者药方相反：前者去修测量，后者去换模型。

已固化为代码：`scripts/eval/rerank-offline-ab.mjs` 的 `judgeRerankNonDegenerate`（五种拒绝理由：`constant` / `not-separated` / `not-number` 等），配 5 条单测。

## 更一般的形态

**「跑通了」不等于「测到了」。**

一个把信号吃掉、却让返回值结构完全合法的中间层——pipeline、adapter、序列化往返、单位换算、默认值兜底——会让**所有探针全绿而结论反向**。

判据要钉在**信号是否还在**上，不能钉在**调用是否成功**上。前者要求你先知道"有信号"长什么样（所以要有非退化对照），后者只需要一次 `try` 没抛异常。
