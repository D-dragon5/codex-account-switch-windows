# 类似项目

查阅日期：2026-10-28。以下依据项目自己的仓库和文档整理；未安装或运行第三方工具，文档中的能力不等于本项目对其可靠性的独立验证。

| 项目 | 已有功能 | 活动保护的文档证据 |
| --- | --- | --- |
| [liuzhao1225/codex-account-switcher](https://github.com/liuzhao1225/codex-account-switcher) | Windows/macOS 原生应用；关闭桌面、保存当前凭证、切换、验证并重开；Windows 使用 ACL 与原子替换。 | [Windows 说明](https://github.com/liuzhao1225/codex-account-switcher/blob/main/windows/README.md)保留独立 CLI 进程，正常退出超时则停止。[产品说明](https://github.com/liuzhao1225/codex-account-switcher/blob/main/docs/product-decisions.md#4-switching-confirmation)告知运行中桌面任务可能停止；未见自动逐聊天空闲检查的说明。 |
| [ZOONGG/codex-swap-account](https://github.com/ZOONGG/codex-swap-account) | Windows 悬浮栏、托盘和快捷键；保存当前最新 auth、备份、原子替换、重启及失败回滚；托盘进程在 Codex 关闭后继续存活。 | [切换流程](https://github.com/ZOONGG/codex-swap-account#how-switching-works)明确防止并发切换；所阅 README 未说明逐聊天 busy 检查。 |
| [Gaebabi/codex-switch](https://github.com/Gaebabi/codex-switch) | Windows/macOS 桌面切换、加密本地存储与恢复检查点、可选额度自动切换、重开原聊天。 | [切换说明](https://github.com/Gaebabi/codex-switch/blob/main/docs/SWITCHING.md)只向符合条件的 idle 未完成聊天发送 Continue；活动统计仅覆盖本机桌面根聊天，排除远程、云端与独立 CLI。这不等于证明所有聊天运行时都会拒绝切换。 |
| [korsun009/codex-account-switcher](https://github.com/korsun009/codex-account-switcher) | Windows 多账号管理；DPAPI 加密凭证与备份、auth 校验、回滚、额度显示及桌面进程管理。 | [README 功能与安全模型](https://github.com/korsun009/codex-account-switcher#features)未说明自动逐聊天活动检测；不能据此断言实现中完全没有该能力。 |
| [errhythm/ccswap](https://github.com/errhythm/ccswap) | Codex/Claude CLI 与跨平台 TUI；保存多账号、查询额度、手动或自动选择账号。[Codex 模式](https://github.com/errhythm/ccswap/blob/main/docs/codex.md)只替换认证文件并保留其它本地数据。 | [重启行为](https://github.com/errhythm/ccswap/blob/main/docs/how-it-works.md#restarts-and-session-behavior)明确不终止运行中的 Codex，而是提醒用户重启；未自动完成桌面关闭与重开。 |

关闭、保存、替换、验证、重开的模式已有 Windows 实现。本项目定位为可由代理调用的轻量脚本与技能；WMI 生命周期隔离、活动检查和有限等待属于需要验证的实现选择，不据此宣称首创。

活动检查应注明观察范围与失效条件。仅看到进程存在、某个日志为空闲，或新启动的 app-server 没有活动，均不足以证明现有桌面的所有聊天都已空闲。
