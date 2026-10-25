# API 调用与统计约定

本候选提供 `cachepilot_api_status`、`cachepilot_api_preview`、`cachepilot_api_request`、`cachepilot_api_gateway_start/stop`、`cachepilot_api_cache_clear`。请求参数只有本地 profileId 和原生 body，不接受调用方指定 Key、鉴权头、任意 URL、文件或代理。配置来自用户的本机绑定操作；无真实宿主租户 ID、凭据代次或实际模型版本接入。

0.1.2-semantic.1增加独立CPU回答缓存，规则和未覆盖项见README。只对插件内明确请求启用；网关仍为原路径。命中不发送厂商请求，返回local_semantic_cache来源，去掉历史usage并保持云端用量未测量；不得把本地命中或分词估算混入下面的厂商字段统计。未命中不改原文、不截断、不自动重试。中文仅精确复用。

| 协议 | Base URL 形式 | 鉴权头 | 追加方法路径 | 输出上限 / 缓存读取来源 |
|---|---|---|---|---|
| openai-responses | https://公网域名/v1 | Authorization: Bearer | /responses | max_output_tokens、store:false / usage.input_tokens_details.cached_tokens |
| openai-chat | https://公网域名/v1 | Authorization: Bearer | /chat/completions | max_completion_tokens / usage.prompt_tokens_details.cached_tokens |
| deepseek-chat | https://公网域名（也可 /v1） | Authorization: Bearer | /chat/completions | max_tokens / usage.prompt_cache_hit_tokens；嵌套字段须一致 |
| anthropic-messages | https://公网域名/v1 | x-api-key；anthropic-version:2023-06-01 | /messages | max_tokens / usage.cache_read_input_tokens |
| gemini | https://公网域名/v1beta | x-goog-api-key | /models/编码模型名:generateContent | generationConfig.maxOutputTokens / usageMetadata.cachedContentTokenCount |

本轮五协议测试逐项检查上述鉴权名称/前缀、完整 Base URL 与方法路径，并验证准备阶段不填 Key。只验证本地适配器与模拟传输，不是任何真实厂商端点验收。

Base URL 填路径前缀，插件再加对应接口路径；不能填完整的 `/chat/completions` 等方法地址。只接受 HTTPS 公网域名 443，DNS 解析结果全部校验并固定连接地址，TLS 校验保持开启。协议字段子集由 `api/protocols.mjs` 严格检查；不支持字段会拒绝，不自动删除或翻译。JSON 外壳可能重新序列化，不承诺发送字节或远端 Token 一致；用户文本、角色、消息/工具顺序不做归一化、去重或裁剪。

例如 OpenAI 兼容 Chat 的 body（仅示例，不会自动发送）：

```json
{"model":"与本机配置完全一致的模型名","messages":[{"role":"user","content":"用户批准发送的文本"}],"max_completion_tokens":32}
```

`preview` 返回目标、bodyHash、字节数、输出上限而不解密 Key；发送时本机审批窗口绑定请求 ID、目标和该正文摘要，默认拒绝，最多等待 45 秒。审批通过后才读取 Key；解密助手通过私有 stdin/stdout 通道通信，不把 Key 放在命令行、MCP 参数、环境或日志里。普通助手失败、取消或配置变化结束本次动作；只有助手退出未确认时，才隔离暂停本进程的后续动作。

本机配置保存在 `%LOCALAPPDATA%\CachePilotApi\profiles\<id>.json`，Key 是 DPAPI 密文，ACL 限当前用户与 SYSTEM。这是唯一生产凭据来源，不读环境变量、钥匙串或请求参数作为回落，不打印 Key 或其前缀。`credentialGeneration` 是插件本地绑定代次，不是真实厂商凭据版本。作用域按 profileId、协议、Base URL、模型配置与本地代次隔离；在途结果提交前重新核对，变化则丢弃。实际租户/模型版本仍为“身份未核实”，不能计为已核实原样延续。

每进程只允许一个发送任务，无排队；单条元数据读取最多 5 秒，原生助手最多 45 秒加最多 2 秒退出确认；网络总截止最多 60 秒，覆盖 DNS 与发送前复核。超时值是事件循环定时目标，不承诺系统阻塞时严格到点。取消会拒收迟到结果、请求中止下层操作；不能保证厂商停止计费。不能确认助手退出时暂停此进程直至重启。预算在尝试前预留，不因错误自动退款；缺输入/输出用量或发送错误会暂停相应作用域。重启会重置本地限额，不是账户总限额。

云端读取率 = 同一批具备有效缓存字段记录的缓存读取 Token / 这些记录的输入 Token，数据均来自同一接口返回。Anthropic 分母须完整包含普通输入、缓存读取、缓存写入；缺任一分母组成不猜测。缺字段不填 0；真实 0 计数可保留，但分母 0 不显示比例。`reportingCoverage` 是具备可核对缓存字段的请求数/尝试请求数，不是命中率。`providerCacheMeasured` 只表示具备有效正分母的接口报告，不表示原厂认证、插件因果增益或费用节省。代理服务可以自行伪造 usage。

0.1.1 的 `cacheWriteTokens` 独立累计已报告且合法的写入字段：缺读取或普通输入时也保留写入，不因此生成读取率。`reportedRequests` 和 `unknownUsageRequests` 仍描述读取分母的覆盖情况；已知写入和未知读取可以同时存在。写入累计 0 只是当前已报告字段的加总，因无独立写入覆盖字段，不能断言所有请求都实测写入为 0。监控明确标注覆盖未知、不计入命中。定时刷新不重加记录。

每进程最多 16 个预留发送作用域；不驱逐旧额度。拒绝审批也保留位置；第 17 个在审批/凭据读取/发送前返回 `API_SCOPE_LIMIT`。预览、状态不消耗位置。`status.scopeCapacity` 的 reserved、recorded 和 remaining 分别表示已预留、已产生尝试记录和剩余容量。并发仍只允许一个任务，先按 `API_BUSY` 拒绝，释放后再确定是否达到作用域上限。缺账单用量后的暂停不会自动清零。

API 曲线按 PID+processSession+scopeId 隔离，近 120 秒使用当前窗口有效快照差；首次打开/切换/恢复的首帧不画假流量。近 120 秒与进程作用域累计分别显示。帧过期、缺字段、无分母和样本不足分别显示状态，不用 0% 代替。API 侧统计不含宿主聊天用量；本地估算 Token/分词缓存命中也不计为 API 命中。

可选回环网关仅做固定协议路由，非流式、无协议转换；令牌与上游 Key 不同，浏览器 Origin 被拒绝，调用方头部不转发上游。超限以客户端收到完整状态、头部及错误体为响应送达，413/429/415 后采取有界排空和连接关闭。250ms 是清理定时目标，拥塞时可能延迟。测试验证本插件无自动重试，外部客户软件自身的重试需用户另行关闭。网关并不替用户生成费用上限。

字段定义参考（只使用公开接口规范，未引入 SDK）：[OpenAI 缓存说明](https://developers.openai.com/api/docs/guides/prompt-caching)、[DeepSeek Chat](https://api-docs.deepseek.com/api/create-chat-completion/)、[Anthropic 缓存说明](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)、[Gemini generateContent](https://ai.google.dev/api/generate-content)。具体账号、模型及服务实时支持情况尚未实际验收。
