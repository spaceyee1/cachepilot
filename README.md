# CachePilot independent review candidate

Project-owned contributions: **[Apache-2.0](LICENSE)**. Third-party notices: [NOTICE](NOTICE) and [NOTICE.md](NOTICE.md).

API plugin: **0.1.2-semantic.1**. Monitor: **0.1.1-ui.9**.
The currently installed native tokenizer plugin remains **0.6.8**. These are separate component versions, not Codex versions. This candidate is not installed.

## Try the monitor on Windows x64

Double-click `Start-Monitor.cmd`, or run `powershell -NoProfile -File scripts/Start-Monitor.ps1 -SelectedPid YOUR_SOURCE_PID`.
Use the source PID returned by the current chat's `cachepilot_status`. The monitor's own window PID is a different process. A directory copy does not create another telemetry pipe: if another monitor owns the same per-user pipe, this window reports the channel unavailable; it never closes the other monitor.

For a separate local settings file, double-click `Start-Portable.cmd`. User mode stores settings under `%LOCALAPPDATA%/CachePilot/profiles/default/`; portable mode uses this package's `data/profiles/default/`. Saving a GPU setting only writes next-start configuration. It does not switch the running plugin. GPU is off by default; this review does not enable it.

The monitor includes folding, mouse-wheel scrolling, and Token/rate charts. The rolling chart means **local Token analyses / local cross-call cache reuse over the last 120 seconds**. Periodic snapshot refreshes are not new token input. The first valid frame establishes a baseline; PID changes/reconnections discard the old window. Insufficient samples hide the percentage; an expired interval with no new input shows `暂无新增输入`. Process-lifetime counters are shown separately. Token estimates are not generated tokens, host usage, or billing.

API Token and cloud cache rate show **未测量** until actual API telemetry is available. Local tokenizer hits and local semantic response hits must not populate cloud cache fields. Opening the window does not call an API or read a Key.

## API and semantic cache

Only explicit `cachepilot_api_request` calls enter the candidate API layer. Installing/enabling its MCP entry is a separate user action; opening its monitor does not attach the API plugin to this chat. The candidate does not intercept the current chat or control Codex/DeepSeek server KV memory.

The API configuration uses the local binding helper on an explicit click. It retains per-request local approval, bounded budgets, no automatic retry, and default `networkEnabled:false`. Do not paste a Key into chat or commit a credential store. See `API-GUIDE.md` for protocols and limits.

Semantic response reuse is **disabled in the distributable default configuration**. To opt in, copy `semantic-settings.json` outside the repository, fill the existing local Python/model paths, set `enabled:true`, and provide its absolute path through `CACHEPILOT_SEMANTIC_CONFIG` before MCP startup. No model or Python dependency is downloaded or bundled. Invalid or missing settings disable semantic reuse. This release's semantic encoder is CPU-only; it rejects CUDA/auto. The GPU settings button applies to the older native ranking path, not this encoder.

Semantic matching uses local all-MiniLM-L6-v2, threshold 0.97 and margin 0.02. Exact lookup precedes guards; negation, numbers, literals, URLs, time-sensitive/comparison text and non-ASCII text are excluded from approximate reuse before embedding. Chinese currently permits exact reuse only. History, roles, system instructions, tool/parameter context and locally bound profile/credential generation must remain in scope. Real host tenant identity and actual provider model revision remain **身份未核实**. Approximate similarity is not proof of answer equivalence. No 99% hit-rate or billing-saving claim is made.

The process-local cache is bounded, expires entries, and does not persist responses to disk. Local reuse returns `sent:false` with its local source, does not replay provider usage or increment the cloud ledger. Provider cache performance and causal improvements remain **未测量**. Oversized model inputs are not truncated. Cancelling does not guarantee a provider stopped billing.

## Build, test, and source-only checkout

The runnable local package includes its isolated Node runtime. A Git checkout intentionally excludes `runtime/node.exe` (over the repository's ordinary large-file limit), generated EXEs, logs, local configs and raw machine audit records. Preserve `runtime/LICENSE.node.txt` and checksum materials. A source checkout needs a compatible independently verified Windows x64 Node executable in that location, followed by native builds; no script automatically installs a shared runtime.

```powershell
powershell -NoProfile -File scripts/build-local-helper.ps1
powershell -NoProfile -File scripts/build-monitor.ps1
.\runtime\node.exe --import ./tests/offline-guard.mjs --test --test-concurrency=1 tests/*.test.mjs
pwsh -NoProfile -File scripts/test-ui8-offline.ps1
```

`MANIFEST.sha256.json` in this repository binds the current source files, excluding dist ZIPs. The separate Windows x64 runnable ZIP carries its own full-product manifest including the reviewed binaries. These two manifests cover different file sets. Hashes establish content consistency, not publisher authenticity; project EXEs remain unsigned. Recompiling may change binary bytes. The UI verifies Monitor.xaml against embedded trusted bytes before loading it. A same-user attacker able to replace the EXE or interpreter remains outside that guarantee.

See `docs/VALIDATION.md` for this review's executed checks and explicitly unverified branches, `SECURITY.md` for threat boundaries, and `NOTICE.md` for third-party materials. Current verification is offline application testing with a process-local external-network guard, not a new full CVE scan, internet plagiarism search, or OS firewall. No real service stop/restart, disconnection, GPU inference or 8B test is included. Machine-specific service/memory diagnostics remain outside product logic; `docs/MEMORY-REVIEW.md` explains the historical estimate.


## Downloadable delivery

See [docs/DELIVERY.md](docs/DELIVERY.md) for the source and Windows x64 ZIPs.
The product entry point is unchanged; no experimental audit backend is merged.
GPU remains off by default. No model or provider Key is included.
[Recent diagnostic summary](docs/DIAGNOSTICS-2026-10-26.md) is observation-only.
Raw local audit records and machine inventories are not part of this delivery.
