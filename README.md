# Codex Account Switch — Windows

用于 Windows Codex 桌面的轻量账号切换脚本与代理技能：检查聊天状态，自动退出桌面，保存并替换凭证，验证后端认证，再重开桌面。支持一个 Pro 与一个 Plus 账号。

Lightweight scripts and an agent skill for switching a Windows Codex desktop between saved Pro and Plus accounts. No third-party runtime packages. This is an independent community project.

## 功能与范围

- 独立 WMI 后台进程，校验 Windows 作业隔离、用户、会话及执行路径；关闭 Codex 后继续执行。
- 调度前和关窗前检查本地聊天最新轮次；其它聊天仍运行时拒绝切换。调用切号的当前轮次需先结束。
- 默认启动等待 **3 秒**，正常退出等待最多 **5 秒**；随后仅处理经过身份核验的目标桌面及账号引擎。
- 校验凭证身份，保存源账号最新凭证与回滚副本，原子替换并设置私密文件权限。
- 后端认证完成后再次保存目标凭证；仅在令牌字段确实变化时记录刷新变化。
- 按本工具策略检查两个域名的现有美国出口，沿用当前网络。没有修改 VPN、节点、TUN 或系统代理的命令。
- 共享锁、待执行任务检查、失败恢复和安全错误码。

## 运行条件

Windows 10/11、Node.js **24+**、Windows PowerShell 5.1，以及已登录的 Codex 桌面。使用文件形式的 `auth.json`，不支持只保存在系统密钥环的登录。网络检查可读取 Clash Verge Rev 的当前混合代理端口，或使用本地配置中明确指定的 HTTP 回环代理。

```powershell
node scripts/switch-account.cjs status
node scripts/switch-account.cjs save pro
```

分别正常登录两个账号并执行对应的 `save`，或在本机配置中提供现有只读凭证来源。账号计划必须与 `pro` / `plus` 标签一致。凭证存在和过期信息属于离线检查，在线可用性由切换流程另外验证。

```powershell
Copy-Item config.example.json config.json
node scripts/switch-account.cjs plan plus
node scripts/switch-account.cjs switch plus --execute
```

`config.json` 不入库。默认目录为 `CODEX_HOME`（未设置时为用户的 `.codex`）下的 `account-switch/vault` 与 `account-switch/state`。可覆盖 `authPath`、`vaultRoot`、`stateRoot`、`nodePath`、`clashConfigRoot`、`launchDelaySeconds`、`closeGraceSeconds`，以及每个账号的 `credentialSources`。例如使用已有本地 HTTP 代理时，在本机配置增加 `"proxyUrl": "http://127.0.0.1:7897"`，端口应与实际代理一致。

代理调用时应保留 Codex 提供的 `CODEX_THREAD_ID`。手动运行时没有调用方豁免，所有本地聊天都必须空闲。脚本收到调度成功后会自动完成后续步骤；操作期间不要开始新任务。

## 作为技能使用

将这个仓库放在个人技能目录下，文件夹命名为 `codex-account-switch`，保留根目录 `SKILL.md`、`agents/` 和 `scripts/`。代理读取 [SKILL.md](SKILL.md) 后调用脚本。更新时保留本机 `config.json`，不把凭证复制进技能目录。

## 聊天检查与验证边界

聊天检查只读本机 Codex home 的 `thread_history_1.sqlite`，每个线程只取最新轮次，避免把已被后续轮次覆盖的旧 `inProgress` 当成当前任务。其它活动轮次、调用方新轮次、未知状态、数据库缺失或结构变化都会阻止关窗。它依赖当前已验证的本地实现，不能证明其它电脑、远程/云会话也空闲；检查与关闭之间也有很短的时间间隔。

`restarted_pending_desktop_confirmation` 表示目标凭证的后端认证已通过且桌面已启动。桌面账号需由原生账号/额度工具或头像菜单另行确认。`sourceCredentialSaved` / `targetCredentialSaved` 表示已保存，`tokenFieldsChangedDuringValidation` 才说明认证期间令牌字段发生变化；有效令牌不强制刷新。

较早的 20 秒/15 秒版本已完成真实 Pro → Plus → Pro 桌面切换，并在重开后核对原生套餐状态。当前 3 秒/5 秒版本的自动化检查、Windows 真实进程测试及其范围见 [验证说明](docs/validation.md)；总耗时还取决于进程退出、网络、文件权限和认证，3 秒不是全流程耗时承诺。

## 测试

```powershell
node --test
powershell -NoProfile -ExecutionPolicy Bypass -File tests/windows-smoke.ps1
```

单元测试使用合成凭证、模拟网络和桌面操作。Windows 冒烟测试仅启动并终止测试自有进程，不登录账号、不调用真实切号入口、不关闭 Codex。

GitHub Actions 自动运行上述两类测试。完整合成流程保留为本地手动测试：`node tests/pipeline-smoke.cjs`；它在 GitHub 托管 Windows 上仍有后台完成超时，暂未纳入自动 CI，详见 [验证说明](docs/validation.md)。

## 凭证与隐私

`auth.json` 和账号副本包含登录令牌，应按密码保管。代码库仅包含通用源码、合成测试和示例配置；本机配置、账号来源、状态、任务清单、数据库、诊断与回滚文件均不发布。凭证目录应位于仓库外，并受本机文件权限保护。

账号切换已有多个成熟方向的实现，本项目不主张首创。参见 [同类项目对照](docs/related-projects.md)。

MIT License.
