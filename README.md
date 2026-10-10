# omp-quick-provider

Oh My Pi（`omp`）扩展：**用对话框快捷添加 / 管理任意 OpenAI / Anthropic / Gemini 兼容的 API 供应商**（base URL + API Key），不用手改 `models.yml`。

```
/qkprovider add      # 弹窗式添加：URL → ID → 协议 → 密钥（不回显）→ 自动探测模型
/qkprovider list     # 列出供应商、密钥来源与当前模型数
/qkprovider refresh  # 强制刷新模型目录（24h 缓存的在线刷新）
/qkprovider delete   # 删除供应商（remove 同义）
```

## 功能

- **多供应商 CRUD**：每个条目独立 base URL、协议与密钥，互不影响。
- **自动模型发现**：按协议拉取目录并缓存 24h（宿主 `models.yml` 同款缓存链路）。
  - `openai-completions` / `openai-responses`：`GET <baseUrl>/models`
  - `anthropic-messages`：`GET <baseUrl>/v1/models`（`x-api-key` + `anthropic-version`，`after_id` 翻页）
  - `google-generative-ai`：`GET <baseUrl>/models?key=…`（`pageToken` 翻页，并按 `supportedGenerationMethods` 过滤非生成模型）
- **失败绝不清空**：网络错误 / 超时 / 非 2xx / 坏 JSON / 无列表一律视为失败，保留上次目录（stale）；只有端点明确返回空列表才会清空。模型不会在 `/model` 里"突然消失"。
- **屏蔽输入**：密钥输入框不回显（`omp` 18.1.22 自带的 `/login` 与 `ui.input` 都不支持遮蔽）。
- **写入安全**：存储原子写入（唯一临时文件 + rename）；文件损坏时先备份 `.corrupt-<ts>` 再继续，读失败直接拒绝操作；覆盖/删除前会重读合并，多实例并发不丢数据。
- **导入 base URL 规范化**：按协议补 `/v1`、去尾 `/v1`、补 `/v1beta`；拒绝带查询参数 / `#` 片段 / 内嵌账号的 URL。

## 安装

要求：`omp` ≥ 18.1.22（实测 18.1.22；更早版本未验证）。

**方式 1：复制单文件（最简单）**

```bash
git clone https://github.com/R0smontis/omp-quick-provider
cp omp-quick-provider/extensions/quick-provider.ts ~/.omp/agent/extensions/
```

Windows 路径为 `%USERPROFILE%\.omp\agent\extensions\`。重开 `omp` 即生效。

**方式 2：`omp plugin link`（跟随源码目录）**

```bash
git clone https://github.com/R0smontis/omp-quick-provider
omp plugin link ./omp-quick-provider
```

**方式 3：marketplace 目录**（见 `omp` 文档 `docs/marketplace.md`），把本仓库作为 catalog 源加入后 `omp plugin install`。

## 使用

1. `/qkprovider add`
2. 依次填写：**Base URL**（如 `https://host/v1`）→ **Provider ID**（模型名前缀，`my-gw` 对应 `my-gw/model`）→ **API 协议** → **API Key**（不回显，可留空）。
3. 扩展会先探测一次 `<baseUrl>/models`：成功则直接写入；失败会提示原因，并允许手动填写模型 ID（逗号分隔）。
4. 通知里会显示模型数量；`/qkprovider refresh <id>` 可随时重拉。

**密钥的存放与优先级**（宿主凭据链规则）：

| 来源 | 存哪 | 优先级 |
| --- | --- | --- |
| 向导里填的 Key | `~/.omp/agent/quick-providers.json`（0600，明文，与 `models.yml` 的 `apiKey` 同层级） | 高于 `/login` 存储 |
| `/login <id>` | `omp` 凭据库（SQLite） | 低于向导录入 |

因此：**要更换向导录入的密钥，请重新 `/qkprovider add` 覆盖该 ID，或先 `/qkprovider delete <id>` 再 `/login <id>`。** 只想用 `/login` 管理密钥时，添加时把 Key 留空即可。

`/qkprovider list` 会标注每个条目的密钥来源（`向导录入` / `凭据库/环境`）。

## 存储与恢复

- 路径：`~/.omp/agent/quick-providers.json`（跟随 `PI_CODING_AGENT_DIR`；Linux/macOS 上若存在 `$XDG_DATA_HOME/omp` 则用其）。
- 损坏恢复：JSON 无法解析时，原文件被改名为 `quick-providers.json.corrupt-<时间戳>`，扩展继续以空列表运行——**原数据不会被覆盖**。
- 删除条目：`/qkprovider delete <id>`（TUI 中会二次确认）。

## 开发与测试

```bash
node --test test/    # 需要 Node ≥ 22.6（原生 TS 类型擦除），实测 Node 24
```

测试用本地 mock 端点覆盖：发现成功 / 失败保留 / 空目录 / 分页（anthropic、gemini）/ 封套变体 / URL 校验 / 损坏备份 / 并发合并 / 覆盖注销 / 冲突确认 / 遮蔽渲染等 14 个场景。

## 已知限制

- `omp` 18.1.22 中斜杠命令需要已选中模型才能提交；首次配置时若一个可用模型都没有，先在 `models.yml` 或环境变量里给一个密钥，再运行 `/qkprovider`。
- 隐藏的 `omp` 内核细节（`fetchDynamicModels` 的"空数组=权威空目录、抛错=保留旧目录"语义）是 18.1.22 实测行为，未来大版本若变更需回归测试。
- 密钥以明文存于上述 JSON（`0600`）；请确保 `~/.omp/agent` 目录本身未被共享。

## English

`omp-quick-provider` is an [Oh My Pi](https://github.com/can1357/oh-my-pi) extension that adds and manages arbitrary OpenAI/Anthropic/Gemini-compatible API providers (base URL + API key) through dialogs: `/qkprovider add|list|refresh|delete`. It features protocol-aware model discovery with pagination, a never-prune-on-failure policy, a masked secret input, and a crash-safe atomic store (`~/.omp/agent/quick-providers.json`).

Install: copy `extensions/quick-provider.ts` into `~/.omp/agent/extensions/`, or `omp plugin link` the repository. Licensed under MIT.

## License

[MIT](./LICENSE) © 2026 R0smontis
