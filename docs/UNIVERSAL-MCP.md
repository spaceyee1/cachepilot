# 通用 MCP 接入

CachePilot 的宿主接口是本地 stdio MCP。入口 `scripts/api-mcp.mjs` 暴露
`cachepilot_api_*` 工具，不检查 Codex 客户端名称，不使用 Codex 私有 SDK。
根目录不再提供 `.codex-plugin/plugin.json` 或宿主自动加载的 `.mcp.json`。
`package.json` 的 `cachepilot` 字段只是本项目的入口说明，不是新的通用安装标准。

MCP 客户端的配置文件位置、外层 JSON/TOML 格式和审批设置各不相同。
参照 [MCP 官方本地服务接入说明](https://modelcontextprotocol.io/docs/develop/connect-local-servers)，
为客户端设置绝对 `command`、`args` 及 GPU 关闭环境。

## 生成配置，不自动安装

Windows x64 运行包：

```powershell
.\runtime\node.exe scripts/mcp-config.mjs
.\runtime\node.exe scripts/mcp-config.mjs --format server
```

第一条输出 `{"mcpServers":{"cachepilot":{...}}}`；第二条只输出内部服务对象，
供使用其他外层结构的客户端手动配置。不要直接覆盖已有宿主配置。
生成结果固定当前 Node 和当前包目录的绝对路径，没有 `cwd` 或
`startup_timeout_sec` 等宿主扩展字段，不继承 Key/Token 等环境变量到输出。
服务按自身文件位置定位模块和助手，不要求客户端的工作目录等于包目录。
移动包目录或更换 Node 后重新生成。

源码包需先提供已核验的 Node，再按 README 编译 Windows helper/monitor。
Node 的既有版本和 OpenSSL 门槛保持不变；`npm start` 使用 PATH 的 Node，
也接受服务启动时的同一门槛检查。建议直接用选定 Node 的完整路径运行生成器，
避免宿主 PATH 选到旧运行时。没有自动下载、全局安装或宿主设置写入。

## 功能与边界

- 通用宿主接口：本地 stdio MCP，按请求显式调用工具。
- 非 MCP 客户端：可选、临时的回环 HTTP 网关，需要用户显式启动、单独令牌和本机审批。
- 当前支持的生产平台：Windows；DPAPI、可见审批及透明框没有被改为明文凭据或环境 Key 回落。
- 五种上游协议见 API-GUIDE；不保证所有兼容客户端的私有字段都受支持。
- API 和 UI 的组件版本不变；本次只修改接入、元数据、说明和对应测试。
- API 图表来源是 `cachepilot_api_status` 的进程；本地分词区需要另有兼容统计发布进程，未随本 API 包分发，缺失时显示无数据。不用窗口 PID 或宿主日志填补它。
- 网关、缓存、预算、鉴权、凭据存储、MCP 协议实现及 UI 代码保持原字节。
- GPU 关闭，语义缓存仍默认关闭；无 API 数据时仍为“未测量”。
- 不接管宿主聊天、读取宿主凭据或控制服务端 KV 缓存。

Codex 用户也可按其 MCP 配置规范接入同一个服务，无需专属插件包。
客户端具备 MCP 功能不代表本次已在该客户端完成端到端验收。

## 本次验证

执行环境：新独立副本、Node26.12.1 / OpenSSL3.5.9，GPU 隐藏并关闭，
进程级外网拦截开启；本机回环、管道和 stdio 夹具允许。没有 Key、厂商请求或实模运行。

- 接入专项：9/9，通过项包括两种输出格式、参数拒绝、环境隔离、图标及元数据，
  以及两个不同 generic clientInfo 从其他工作目录启动真实服务并 initialize/list/status/EOF 退出。
- 完整离线回归：两轮各386项、385通过、1失败、0跳过/取消/待办。
  失败均是旧 `profiles.test.mjs` 中创建目录联接夹具返回 `EBUSY`，
  发生在调用产品的 `loadProfile` 之前。此项仍为未验证，不算通过，不归因为通用接入修复。
- 9项专项中的2项替换原有元数据测试、7项新增；专项与全量有重叠，不能相加计数。
- 网关、缓存、鉴权、UI、协议实现与 API MCP 服务入口按基线逐文件 SHA-256 核对，未改变。

这不是具体编辑器的可见界面验收，也没有复跑此前 UI、真实提供商或模型验收。
不能把通用 MCP 协议测试解释为全部客户端或跨平台已验证。
