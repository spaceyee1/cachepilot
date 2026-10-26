# CachePilot — 通用 MCP 缓存与 API 插件

CachePilot 面向支持本地 **stdio MCP** 的宿主，提供显式 API 调用、本地缓存复用与用量监控。Codex 只是可接入的宿主之一；本版本不含 `.codex-plugin` 专属包装，也不依赖 Codex SDK。不同宿主的配置位置和界面仍需按各自规范设置，未宣称全部客户端均已实测。

当前完整 API 绑定、凭据审批与透明框仍依赖 **Windows**（DPAPI / .NET）。通用的是宿主接入协议；macOS/Linux 的完整凭据与界面适配尚未完成。

## 通用接入

在 Windows x64 运行包中执行：

```powershell
.\runtime\node.exe scripts/mcp-config.mjs
```

命令只输出 `mcpServers` JSON，使用本次运行的 Node 与服务脚本的绝对路径，不读取 Key、不写宿主设置、不启动 API 网关。把生成的 `cachepilot` 条目合并到宿主的 MCP 配置中；需要单个服务对象的宿主可用 `--format server`。GPU 默认关闭。请保留输出中的 GPU 关闭设置；搬动目录后重新生成配置。

源码包不带 Node 或 EXE：请用经过独立核验、满足本项目版本门槛的 Node 运行该脚本，并先编译 Windows 凭据助手。`npm start` 使用当前 PATH 的 Node；生成的宿主配置则固定为生成时使用的 Node。详细步骤与验收范围见 [通用 MCP 接入](docs/UNIVERSAL-MCP.md)。

不支持 MCP 的客户端可在用户明确启动可选回环网关后接入受支持的协议路径；本插件不会因接入而自动接管其他软件或当前聊天的全部请求。HTTP 协议兼容范围见 [API-GUIDE.md](API-GUIDE.md)。

Project-owned contributions: **[Apache-2.0](LICENSE)**. Third-party notices: [NOTICE](NOTICE) and [NOTICE.md](NOTICE.md).

API plugin: **0.1.2-semantic.1**. Monitor: **0.1.1-ui.9**.
The author's existing native tokenizer installation remains **0.6.8**, outside this package. It is not a prerequisite for the generic API tools and is not bundled here. These are separate component versions, not host versions. This candidate does not install itself.

## Try the monitor on Windows x64

Double-click `Start-Monitor.cmd`, or run `powershell -NoProfile -File scripts/Start-Monitor.ps1 -SelectedPid YOUR_SOURCE_PID`.
For API charts, use the API source PID returned by `cachepilot_api_status`; the monitor's window PID is a different process. The local tokenizer area requires an additional compatible local statistics publisher, which this API package does not bundle; without one it shows no data. Only users who already run the separate tokenizer component can obtain that area's source PID from its `cachepilot_status`. These two sources are not interchangeable. A directory copy does not create another telemetry pipe: if another monitor owns the same per-user pipe, this window reports the channel unavailable; it never closes the other monitor.

For a separate local settings file, double-click `Start-Portable.cmd`. User mode stores settings under `%LOCALAPPDATA%/CachePilot/profiles/default/`; portable mode uses this package's `data/profiles/default/`. Saving a GPU setting only writes next-start configuration. It does not switch the running plugin. GPU is off by default; this review does not enable it.

The monitor includes folding, mouse-wheel scrolling, and Token/rate charts. The rolling chart means **local Token analyses / local cross-call cache reuse over the last 120 seconds**. Periodic snapshot refreshes are not new token input. The first valid frame establishes a baseline; PID changes/reconnections discard the old window. Insufficient samples hide the percentage; an expired interval with no new input shows `暂无新增输入`. Process-lifetime counters are shown separately. Token estimates are not generated tokens, host usage, or billing.

API Token and cloud cache rate show **未测量** until actual API telemetry is available. Local tokenizer hits and local semantic response hits must not populate cloud cache fields. Opening the window does not call an API or read a Key.

## API and semantic cache

Only explicit `cachepilot_api_request` calls enter the candidate API layer. Adding/enabling its generic MCP entry is a separate user action; opening its monitor does not attach the API plugin to a host. The candidate does not intercept host chat or control any provider's server KV memory.

The API configuration uses the local binding helper on an explicit click. It retains per-request local approval, bounded budgets, no automatic retry, and default `networkEnabled:false`. Do not paste a Key into chat or commit a credential store. See `API-GUIDE.md` for protocols and limits.

Semantic response reuse is **disabled in the distributable default configuration**. To opt in, copy `semantic-settings.json` outside the repository, fill the existing local Python/model paths, set `enabled:true`, and provide its absolute path through `CACHEPILOT_SEMANTIC_CONFIG` before MCP startup. No model or Python dependency is downloaded or bundled. Invalid or missing settings disable semantic reuse. This release's semantic encoder is CPU-only; it rejects CUDA/auto. The GPU settings button applies to the older native ranking path, not this encoder.

Semantic matching uses local all-MiniLM-L6-v2, threshold 0.97 and margin 0.02. Exact lookup precedes guards; negation, numbers, literals, URLs, time-sensitive/comparison text and non-ASCII text are excluded from approximate reuse before embedding. Chinese currently permits exact reuse only. History, roles, system instructions, tool/parameter context and locally bound profile/credential generation must remain in scope. Real host tenant identity and actual provider model revision remain **身份未核实**. Approximate similarity is not proof of answer equivalence. No 99% hit-rate or billing-saving claim is made.

The process-local cache is bounded, expires entries, and does not persist responses to disk. Local reuse returns `sent:false` with its local source, does not replay provider usage or increment the cloud ledger. Provider cache performance and causal improvements remain **未测量**. Oversized model inputs are not truncated. Cancelling does not guarantee a provider stopped billing.

## Build, test, and source-only checkout

The runnable local package includes its isolated Node runtime. A Git checkout intentionally excludes `runtime/node.exe` (over the repository's ordinary large-file limit), generated EXEs, logs, local configs and raw machine audit records. Preserve `runtime/LICENSE.node.txt` and checksum materials. A source checkout needs a compatible independently verified Node executable, followed by Windows native builds. It may reside outside this project; no script automatically installs a shared runtime.

```powershell
powershell -NoProfile -File scripts/build-local-helper.ps1
powershell -NoProfile -File scripts/build-monitor.ps1
node --import ./tests/offline-guard.mjs --test --test-concurrency=1 tests/*.test.mjs
pwsh -NoProfile -File scripts/test-ui8-offline.ps1
```

`MANIFEST.sha256.json` in this repository binds the current source files, excluding dist ZIPs. The separate Windows x64 runnable ZIP carries its own full-product manifest including the reviewed binaries. These two manifests cover different file sets. Hashes establish content consistency, not publisher authenticity; project EXEs remain unsigned. Recompiling may change binary bytes. The UI verifies Monitor.xaml against embedded trusted bytes before loading it. A same-user attacker able to replace the EXE or interpreter remains outside that guarantee.

See `docs/UNIVERSAL-MCP.md` for the generic-entry review and `docs/VALIDATION.md` for the earlier candidate's executed checks and explicitly unverified branches, `SECURITY.md` for threat boundaries, and `NOTICE.md` for third-party materials. Verification is offline application testing with a process-local external-network guard, not a new full CVE scan, internet plagiarism search, or OS firewall. No real service stop/restart, disconnection, GPU inference or 8B test is included. Machine-specific service/memory diagnostics remain outside product logic; `docs/MEMORY-REVIEW.md` explains the historical estimate.


## Downloadable delivery

See [docs/DELIVERY.md](docs/DELIVERY.md) for the source and Windows x64 ZIPs.
The MCP service entry remains `scripts/api-mcp.mjs`; host-specific packaging is replaced with generic configuration generation. No experimental audit backend is merged.
GPU remains off by default. No model or provider Key is included.
[Recent diagnostic summary](docs/DIAGNOSTICS-2026-10-26.md) is observation-only.
Raw local audit records and machine inventories are not part of this delivery.
