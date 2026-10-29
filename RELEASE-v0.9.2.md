## Highlights

- Cursor 扩展 **cursor-shared-brain** 双向同步：共用 `sync-coordinator` / `sync-registry`
- 新增 `lib/cross-sync.js`：监听 `~/.cursor/rules/shared-brain/memory` 并 inbound 合并
- bridge、`/shared-memory` 与设置页 mutate 写入改走 `writeStoreSynced`，避免双写

## 安装

```bash
dsh plugin --profile <profile> add https://github.com/youx123/dsh-shared-brain/releases/download/v0.9.2/dsh-shared-brain-0.9.2.tgz
```
