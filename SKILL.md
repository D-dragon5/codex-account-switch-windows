---
name: codex-account-switch
description: Switch between saved Pro and Plus accounts in the Windows Codex desktop app, or inspect/save its file-based login credentials. Restarts only the uniquely identified desktop after checking local chat activity and the existing US proxy egress. Does not change VPN or proxy settings. Questions and skill edits do not trigger a switch.
---

# Codex desktop account switch

Use the scripts in this skill directory with Node.js 24 or newer. Windows PowerShell 5.1, WMI and curl are supplied by Windows. The app must use file-based `auth.json` credentials; this workflow does not manage an operating-system keyring.

## Authorization and target

- “切换到 Plus / 本体” selects `plus`; “切回 Pro / 工作账号” selects `pro`; “切换账号” selects `auto`, the other plan.
- An explicit switch request authorizes backing up credentials, replacing the selected instance's login and restarting that instance. Say briefly that Codex will close and reopen. Inspecting, editing or publishing the skill does not authorize an actual switch.
- First use the native chat-list tool to check running chats and identify the target. Stop for another active chat, an ambiguous desktop, a standalone Codex CLI or another independent account window. Do not terminate unrelated processes.
- The script also checks the local persisted turn state before scheduling and immediately before closing. The requesting turn may still be running when scheduling; it must have finished before closure. Other active chats, a new requesting turn or unverified activity stop the operation. Do not bypass this check with a fresh app-server's empty loaded-thread list.

## Configuration and credentials

`config.json` is an optional, local-only override; copy `config.example.json` when needed. Defaults use `CODEX_HOME` or the user's `.codex` directory, a private account-switch vault/state directory beneath it, the running Node executable, a 3-second launch grace and a 5-second normal-exit grace. Keep the existing local config during an update.

Credential selection checks the vault's `<plan>.json`, then that plan's `credentialSources` in order. A configured source is read-only; refreshed output goes to the vault. An existing corrupt or mismatched-plan credential must cause an error, not a silent fallback. Saving refuses to overwrite the selected saved identity with a different account. Do not display tokens, account emails, upstream authentication responses or proxy controller secrets.

## Commands

Run `node <skill-directory>/scripts/switch-account.cjs <command>`:

| Command | Effect |
| --- | --- |
| `status` | Read credential metadata; no network or credential writes |
| `save [pro\|plus]` | Save the currently logged-in account, with identity validation and the shared operation lock |
| `probe` | Check both existing proxy routes without changing settings |
| `plan pro\|plus\|auto` | Check egress and target credentials without closing the app |
| `switch pro\|plus\|auto --execute` | Schedule the independent account-switch worker |

This package has no proxy-node selection commands. It requires positive US egress observations for `chatgpt.com` and `api.openai.com` under its configured policy. A node name or flag is not evidence of egress location. On a failed or non-US probe, leave network settings unchanged and tell the user what failed.

## Switch and confirmation

1. Read `status`, inspect native running chats, then run `plan` for the requested target.
2. Run `switch ... --execute`. A WMI-launched hidden worker must pass same-user/session, process-path and Windows Job Object checks, then complete its ready/arm/acknowledgement handshake. No ordinary `Start-Process` fallback is permitted for the worker.
3. Once `scheduled: true` is returned, finish the reply immediately so the requesting turn can complete. The worker waits 3 seconds, rechecks credentials/egress and the local chat state, then proceeds independently of Codex.
4. The worker requests normal exit, waits up to 5 seconds and then stops only the exact recognized remaining desktop/account processes. It tolerates processes exiting between checks. Credential replacement requires a fresh proof that the desktop and account engines have all exited.
5. It saves the newest source credential and rollback copy, installs the target, performs backend account/rate-limit authentication, saves the target's latest credential and reopens the desktop over the same observed proxy. Saving bytes does not imply that an unexpired token was refreshed; report the recorded token-change flag accurately.
6. On the next turn, read the configured state's `status.json` and use the native account/usage tool or avatar menu to confirm the desktop account. `restarted_pending_desktop_confirmation` confirms backend authentication and launch only. Do not equate that state with verified desktop identity.

## Failure handling

Before closure, failures leave the desktop and credentials intact. After replacement, restore and verify the source credential before reopening it, and recheck egress. A failed credential restore keeps the app closed with `RESTORE_CREDENTIALS_FROM_BACKUP`; fixing the network does not repair a failed credential write. A partial shutdown must check for an existing desktop before any recovery launch.

Saving and switching share a lock; recent pending jobs also block a save. Do not delete a live lock. If the worker disappeared, verify its process identity, preserve diagnostic state, then recover the dead lock. Never commit configuration, credentials, job manifests, rollback files or local activity databases.

Activity checking uses the current local `thread_history_1.sqlite` projection. Missing/changed schema, unknown statuses or read errors fail closed. It covers that Codex home on this machine, not remote/cloud sessions. A new turn can still start in the short interval between the last check and app closure. See the repository README for scope and validation.
