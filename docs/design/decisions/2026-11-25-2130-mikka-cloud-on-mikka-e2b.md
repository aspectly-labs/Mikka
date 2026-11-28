# Mikka Cloud 的 E2B 机器用 Mikka 自己的 E2B；个人 E2B Key 只在自托管；任务机器两家并存

- Date: 2026-11-25
- **Status:** Accepted (decided; implementation pending. Tier 1 standards — [`orchestration.md`](../orchestration.md) §1, §4 and §7, [`cloud-computer-backend.md`](../cloud-computer-backend.md), [`glossary.md`](../glossary.md) — change in the same PRs as the code, so they never describe behavior that has not shipped.)
- Source: Alex, 2026-11-25, after Mikka was accepted into E2B for Startups (USD 20,000 in E2B credits and the E2B Pro tier): 「关于定价的问题，我们还是学习 Capy 的做法……我们可以像 E2B 一样，发一个一块钱的试用，并且看看规格之内能不能跟 E2B 对齐一下」; 「我们现在有了创业额度之后，就不能再允许用户提供自己的 Key 了，必须走我们提供的服务。如果要走 API Key 的话，就必须由用户自己去托管才行」; 「Cloud 是我们很大的一个优点……我们并不是本地优先的产品」. Alex, 2026-11-26 (relayed by the UI alignment session): keep both task-machine providers behind a remote switch and do not retire the Cloudflare Task Machine ([aspectly-labs/Mikka#3330](https://github.com/aspectly-labs/Mikka/issues/3330)); pricing is mikka-hosted-ui decision `2026-11-26-0300-pricing.md`.
- Replaces in part: [2026-11-01-1200](2026-11-01-1200-own-e2b-key-is-enough-for-cloud.md) (cloud only on the person's own E2B key); [2026-10-31-2300](2026-10-31-2300-orchestration-spec.md) answers 2 and 3 (the E2B key is personal; no caps because the person's key pays); [2026-11-02-2330](2026-11-02-2330-cloud-first-dispatch.md) (the cloud is skipped when the person has no E2B key); [2026-11-15-1900](2026-11-15-1900-models-on-gateway-like-capy.md) the clause of rule 7 that keeps the cloud computer on the person's own E2B key, and rule 7's machine price (machine time now follows the selected provider's list price, hosted decision 2026-11-26-0300).
- Unchanged: the Cloudflare Task Machine stays (`cf_task_machine`, the `cloud.*` and `cloud.eve_factory` rows of [execution route v1](../../factory/execution-route-v1.md)); it is not retired. Task execution runs on Cloudflare or E2B, chosen by a remote switch (PostHog flag `mikka-task-provider`, #3330), and a task machine's snapshot keeps a portable source of truth in Mikka's storage with a cache per provider. Eve stays on Cloudflare. Model subscriptions and model API keys are unchanged (2026-11-15-1900 rules 1 to 4: list price, no markup, own connections first).

## What runs on E2B today (main, 2026-11-25)

- A **Bot machine**: one E2B sandbox per person per workspace, holding each of that person's Bots' desktops (`cloud_machines`, `bot_desktops`; [cloud-computer-backend](../cloud-computer-backend.md) §2).
- A **thread machine** for a cloud thread placed on E2B (`thread_machines`), from the verified official-derived template (`claude`, `codex`, `desktop`), built at 2 vCPU / 4 GiB (`scripts/e2b/build-template.py`).
- Both use the run owner's personal E2B key (`lib/secrets/e2b-runtime.ts`, `ownE2BKeySql` in `lib/rule-dispatch.ts`); with no key, dispatch skips the cloud and the Bot shows 「填入 E2B Key」 (`machineUnavailableCard`). Mikka charges nothing for that time (orchestration §7).

## 规则

1. **Mikka Cloud 上，所有 E2B 机器都跑在 Mikka 自己的 E2B 账户上。** Bot 机器（Bot 的云电脑）和 E2B 上的 thread 机器都一样。平台 E2B Key 放在 Infisical（项目 Mikka，`prod:/platform`，名为 `E2B_API_KEY`），只在服务端读取，界面、日志和 Agent 都看不到。2026-11-25 时 Infisical 里还没有这个 Key：要用拿到创业额度和 Pro 档的那个 E2B Team 新建一个，再存进去。
2. **Mikka Cloud 不再接受、也不再使用个人的 E2B Key。** 「运行位置」里的 E2B Key 一栏、「填入 E2B Key」那一行提示，以及 `cloudReady` 里「没有个人 Key 就跳过云端」的条件在 Mikka Cloud 上去掉：云端总是可用，只在额度不足、管理员关掉「电脑」策略或云端启动失败时跳过。已存的个人 Key 不再被读取，上线前通知持有人，之后删除。
3. **个人 E2B Key 只在自托管。** 自托管部署继续用 E2B Key（`docs/self-hosting.md`），行为不变。
4. **E2B 机器提供 Capy 的规格档位**（Alex，2026-11-25：「我们后续要支持 capy 提供的规格，不能再是固定的 2c4g」），不再只有固定的 2 vCPU / 4 GiB。E2B 的 CPU 和内存在模板构建时定死（`Template.build` 的 `cpuCount`、`memoryMB`；`Sandbox.create` 不能改），所以每一档是同一模板定义的一个构建变体，用模板名区分档位、用 tag 区分版本（E2B 文档 Template names「Multiple template variants」、Template tags）。机器时间按所选提供方的公开原价从余额扣，不加价，只算机器醒着的秒数（hosted 决策 2026-11-26-0300；本记录初稿里的「向上取整到分、按 5 分钟一段预付」不再采用）。E2B 公开价（2026-11-26 核对 e2b.dev）：vCPU USD 0.000014/秒，内存 USD 0.0000045/GiB·秒：

   | 档位（同 Capy） | 规格 | E2B 原价/小时 |
   | --- | --- | --- |
   | Small | 1 vCPU / 4 GiB | USD 0.1152 |
   | Medium | 2 vCPU / 8 GiB | USD 0.2304 |
   | Large | 4 vCPU / 16 GiB | USD 0.4608 |
   | Ultra | 8 vCPU / 32 GiB | USD 0.9216 |

   跑在 Cloudflare 上的任务按 Cloudflare 的原价计。

   **Bot 机器固定用最低档里够用的一档：2 vCPU / 8 GiB**（Alex，2026-11-25：「开一个电脑桌面端的 BOT……开个最低规格就行了，你给 BOT 界面定个 8GB 吧」），从 E2B 官方 `desktop` 模板构建。Bot 机器是每人每工作区一台、由这个人的所有 Bot 桌面共用（[cloud-computer-backend](../cloud-computer-backend.md) §2），8 GiB 是这台机器的总量。大规格只给派出的线程。

   上限：E2B 已批（Professional，2026-11-26）每台沙箱最多 8 vCPU / 32 GiB（32768 MiB）、50 GB 磁盘、100 个并发沙箱、单次 24 小时，按同一用量单价计费，所以四档都可在 E2B 上开。Cloudflare 每实例提高到 4 vCPU / 16 GiB 的申请仍待批（默认 `standard-4` 是 4 vCPU / 12 GiB / 20 GB 磁盘），批下来之前由 `MIKKA_TASK_MACHINE_16GIB_QUOTA` 关着；所以开关选 Cloudflare 时 Large 要等它，Ultra 只在 E2B。Capy 的 Hyper（16 vCPU / 64 GiB）不提供。连续运行 24 小时后暂停，暂停不计费。
5. **套餐和价格以 hosted 决策 2026-11-26-0300 为准**（套餐额度等于售价、按月清零；模型和机器按原价；加购 12 个月过期；超额默认关闭）。本记录初稿里的「Pro 首周 USD 1、首周模型费最多 USD 5」不在那份决策里，是否加上待 Alex 决定；在他决定之前不做。
6. **对外文案以 Cloud 为主打。** 机器叫 **Mikka Cloud**（[glossary](../glossary.md)，不叫 E2B）；不写「E2B 额度」，也不把 E2B 的赞助额度当作商品出售（E2B for Startups 条款第 4 条）。

## 为什么

- 有了 E2B 创业额度和 Pro 档，Mikka 可以替用户付 E2B 机器的钱。用户不用先去 E2B 注册、充值、复制 Key，云端开箱即用。
- 个人 Key 和平台 Key 并存会让计费、并发上限、模板权限和故障提示多一套分支；个人 Key 只留在自托管，Mikka Cloud 上就只有一条路径。
- 机器按提供方原价收：创业额度用完或过期（兑换后一年）也不亏钱；利润来自套餐里没用完的额度（hosted 决策 2026-11-26-0300）。
