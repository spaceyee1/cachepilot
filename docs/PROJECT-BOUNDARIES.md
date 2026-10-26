# 当前能力与运行约束

CachePilot 是独立的通用 MCP API 网关与缓存组件，不依赖群聊或插话项目。
支持本地 stdio MCP 的宿主可明确调用 API 工具，也可由用户启动临时回环 HTTP 网关。
上游支持 API-GUIDE 所列协议字段子集，不代表任意 OpenAI 私有扩展或完整跨平台服务端能力。
API组件0.1.2-semantic.1、监控UI0.1.1-ui.9保持不变。本次只更正文档，不修产品代码。

## Windows 目录联接证据

初次通用接入的两轮全量记录均为386项中385通过、1失败：创建junction夹具返回EBUSY，
尚未执行loadProfile拒绝断言。这一历史结果保留，不追改为通过。

后续独立Windows副本使用Node26.12.1和OpenSSL3.5.9运行196项定向回归，196通过、0失败，
其中原junction断言已执行；另连续5轮重复该断言，每轮1项通过。三种额外场景为目标是祖先目录、
目标是同级目录、路径祖先组件为junction；均先确认创建成功和lstat识别，再由loadProfile返回
UNSAFE_PROFILE_PATH。移除联接后目标文件哈希未变。重复轮次和额外场景与196项分开报告，
不能相加为新的唯一测试总数，也不是全量386项重跑。

这证明所测静态Windows路径的拒绝分支得到执行。旧EBUSY根因、其他reparse类型、目录替换竞态、
此前跳过的XAML符号链接路径仍未覆盖；Linux symlink通过不能代替Windows junction验收。

## 语义缓存范围

分发配置enabled为false。配置本地CPU编码器后，仅cachepilot_api_request工具路径允许语义回答复用；
当前HTTP网关调用request时显式传allowSemantic=false，不使用这层缓存。

semanticLanguage固定为en。抽取的末条用户文本只要包含非ASCII字符（包括中文），就只允许精确复用，
不会进入embedding近似检索。精确比较发生在同作用域和同canonical envelope内：保留system、历史消息、
角色、参数及数组顺序，仅对象键排序，因此不要求整个HTTP body的原始字节相同。上下文变化会改变
分组，英文同样受此限制。有工具、图片或缺少显式temperature=0等情况还可能直接不符合缓存资格。

不把启用语义配置描述为已测节费，不承诺中文命中率或99%收益。不得为提高命中率任意裁剪历史、
改角色/参数、降低否定/数字守卫或混用云端usage。本地回答复用与厂商缓存命中是不同指标。

## Windows 与服务端部署边界

WPF透明框、WinForms可见审批和DPAPI凭据助手依赖Windows。profileDirectory默认在非win32抛出
PROFILE_DIRECTORY_UNAVAILABLE；cachepilot_api_status会先读取profiles，因此默认Linux状态调用
也会失败，不能宣传为Linux已能直接看状态JSON。此结论来自调用链核对，未做Linux动态验收。

Linux/macOS与无桌面服务端部署需要独立的凭据、审批及状态后端；TUI或Web监控亦未实现。
通用MCP接入不等于当前已具备Linux生产部署能力。不得用明文或环境Key回落绕过缺失的适配。

## 地址与DNS边界

定向补测中14个profile拒绝用例覆盖0.0.0.0、[::]、IPv4映射、数字/十六进制/八进制IP写法、
localhost和保留后缀。三组模拟DNS结果（未指定IPv4、未指定IPv6、公私IP混合）均在实际发送前
返回API_DNS_REJECTED，模拟request函数调用次数为0。这些是离线验证，不是对任意网络的安全保证。

已知未修复差异：validateBaseUrl拒绝.onion，而validateEndpoint单独调用会接受同一后缀。
当前正常profile路径会先拒绝它，未复现SSRF绕过；两层规则仍需统一，不能写成已经修复。
增加协议或替换传输层时，必须维持主机、全部DNS结果、固定连接地址、TLS和重定向拒绝的边界。

## 凭据传递约束

生产Key保存在本机DPAPI密文profile中。助手使用本包固定EXE和私有stdin/stdout通道；读取模式
从stdout交付解密结果，Key不来自命令行或环境。不要把Key写入Environment=、环境变量、启动参数、
工具参数或日志。DPAPI不能防御可替换同用户EXE/运行时的攻击者；文件哈希也不是独立签名。

## 并发 审批与预算约束

每进程只允许一个发送任务，无排队，并发以API_BUSY拒绝；不自动重试。不要通过外层自动重试队列
改变审批、内容绑定、预算预留或失败暂停语义。若未来需要高并发，必须先重新设计这些语义再验收。

审批前先预留最多16个作用域位置，拒绝审批仍保留该位置；这不等于拒绝审批也消耗发送次数预算。
请求数和输入输出预算在网络尝试前预留，错误不自动退款。限额是进程会话范围，重启会重置本地计数，
不是提供商账户总限额；取消也不能保证提供商停止计费。

## 验证口径与交付快照

[结构化摘要](boundary-review-2026-10-26.json)只包含去除本机路径的公开结果，不含原始日志、Key、
用户提示词或机器进程清单。测试使用独立执行副本和进程级外网拦截，GPU关闭，无Key或厂商请求；
不是操作系统级物理断网。未运行GPU、模型或远程服务器测试。

既有ZIP和本地Word继续对应其原提交，不因本次文档更新被覆盖。共享Node、原安装、历史报告保持原状。
