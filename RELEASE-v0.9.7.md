## Highlights

- **新增情感模块 `lib/emotion.js`**：每轮对话结束后判定心情，记在 `~/.dsh/storages/dsh-shared-brain/emotion.json`。七根情绪维度（开心 / 踏实 / 甜蜜 / 心疼 / 担心 / 难过 / 吃醋），带基线、衰减、事件注入；主动搭话那一轮也参与判定（反馈闭环）。
- **自动互动改造成「按心情说话」**（新增 `lib/proactive-mood.js`）：定时器醒来先看心情再决定说不说、说什么、什么语气。心情低落更关心更主动，高涨分享进展，中性且刚说过就安静；每天的次数按剩余时间摊开（不会上午用光下午哑火）；话题轮换不重复；「还没 / 待办 / 记得」这类线索优先提醒。
- **底线退出 Cursor 双向同步**：底线只认 DSH 侧（设置页添加或 `/shared-memory` 注入），Cursor 侧只读并单向镜像成规则文件。以前两边互相覆盖、删不掉——因为没有「删除标记」，本地那份永远赢。
- **Cursor 记忆规则扫描补齐 `cognition`**：以前 `~/.cursor/rules/shared-brain/cognition` 里的文件从来没同步进 DSH（修 `lib/cross-sync.js`）。
- **新增目录图谱路径展开 `lib/graph-expand.js`**：召回里带目录图谱路径时展开成可读文件树。
- **密钥脱敏 / 废话不入库 / 清空要按两下 / 时间窗可先填后开 / 人设不再重名两份 / 外部工具写入也过闸门**（0.9.6 那些修复这次一起发出来，它们之前只在本地工作区、没上过 GitHub）。

## 验证

- `test/proactive-mood.test.mjs`：**40 通过 / 0 失败**
- `test/emotion.test.mjs`：**46 通过 / 0 失败**
- 跑法：`node test/proactive-mood.test.mjs`、`node test/emotion.test.mjs`（只读，不碰真实 `~/.dsh`）

## 安装

```bash
dsh plugin --profile <profile> add https://github.com/youx123/dsh-shared-brain/releases/download/v0.9.7/dsh-shared-brain-0.9.7.tgz
```

或手动下载 `dsh-shared-brain-0.9.7.tgz` 后：

```bash
dsh plugin --profile <profile> add ./dsh-shared-brain-0.9.7.tgz
```

## 配套

Cursor 扩展同步发 **v0.4.4**（底线退出双向同步）：
https://github.com/youx123/cursor-shared-brain/releases/tag/v0.4.4
