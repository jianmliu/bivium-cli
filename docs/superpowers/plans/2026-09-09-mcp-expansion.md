# Bivium CLI MCP 扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking. 本文只交付计划，不代表已授权开始实现、发布工具、签名或执行交易。

**Goal:** 在现有 bivium-cli 内，将五个只读策略工具扩展为可发现市场、核对盘口与仓位、评估风险、模拟操作、构建未签名交易、管理已授权订单的 MCP，并为套利及冷启动双边做市提供共用的风险预览能力。

**Architecture:** skills 指导工作流程，MCP 负责参数验证及工具协议，共用 SDK 负责精确计算、状态核验与未签名交易构建。MCP 不持有账户私钥、不签名、不广播链上交易；外部钱包负责逐笔签名和发送。订单发布/移除是独立启用的 relayer 写工具，不与 prepare 混在一起；bivium-mm 保持独立运行，后续可直接消费共用 SDK。

**Tech Stack:** 现有 TypeScript ESM、viem、tsx、node:test；先保留 stdio 与既有启动入口。JSON Schema 使用 Ajv 在工具入口强制校验，作为明确新增运行时依赖；采用 Draft 7 并拒绝隐式类型转换。远程 HTTP/OAuth、自动签名/session key、托管资金、主网部署均不属于本计划。

---

## 0. 本次依据、基线与范围

仓库根目录：`/Volumes/T7-Data/bendle/bivium-cli`。阅读快照 HEAD：`c553decafef3ba5dd327a467f7dc7de014f70a86`。执行前重新检查 HEAD 和工作区；已有两个未跟踪 offer JSON，本计划不读取或覆盖它们。

本次只做源码阅读、官方文档对照和测试：typecheck通过，MCP、orderbook、risk、skill-sync 四组共43项测试通过。未运行全量集成测试、未访问链上账户、未执行资金操作；不能把这个基线当成新功能已实现。

用户已确定的业务目标：MM以净收益和风险控制为目标，既支持价差机会，也允许冷启动时在明确库存和损耗预算内提供双边深度。不要求每张maker订单都已锁定套利；必须区分做市预期收益、单边库存风险和可执行套利路径。

### Aave 参考：借鉴接口流程，不复制产品假设

| 来源 | 已核实的设计 | Bivium 采用方式 |
|---|---|---|
| [Aave MCP Overview](https://aave.com/docs/mcp) | 发现、检查、模拟、构建、钱包签名的分层流程 | 保留操作前后状态预览，prepare不发送交易 |
| [Aave MCP Tools](https://aave.com/docs/mcp/tools) | 市场/账户读取、preview/prepare、签名订单生命周期；结构化结果、错误和后续动作 | 定义相应DCN接口与统一结果，保留原五工具兼容性 |
| [Aave MCP Safety](https://aave.com/docs/mcp/safety) | MCP不保管私钥，钱包是签名边界 | 显式address作为模拟主体，不把私钥或key-file作为工具参数 |

参考日期：2026-09-09。这里使用官方文档，不声称抓取过Aave线上tools/list；文档也说明实时schema以tools/list为准。Aave的health factor、浮动利息、清算和reserve规则不映射为Bivium的协议规则。Bivium需要显示期限、还款/交割分支、不同资产交割和订单库存敞口。

### 当前可复用资产与缺口

所有下列路径均相对于上述仓库根目录；这是文件实施位置，不是新的仓库结构。

| 当前文件 | 可复用内容 | 扩展必须解决的缺口 |
|---|---|---|
| `src/mcp/server.ts` | initialize、tools/list、tools/call、stdio、structuredContent、5个工具 | schema只是声明，缺系统性校验、分页/超时预算、稳定错误码和能力清单 |
| `src/sdk/client.ts` | verifyProfile、position、credit/liquidity/escrow、offerStatus、ABI adapter | write把simulate与wallet.writeContract绑定；account getter需要signer，不能用于纯address模拟 |
| `src/sdk/orderbook.ts`、`trade.ts` | 排序、cap/consumed、扫单、成本取整、交易preflight | 多单共享group时不能把每单剩余额度直接相加；preflight依赖签名账户；构建/执行需解耦 |
| `src/sdk/relayer.ts` | 读取、发布、delist、有超时 | 需要保存业务状态、核对返回结果、处理提交结果未知；relayer列表不等于全部有效签名 |
| `src/sdk/strategies/risk.ts`、`stress.ts` | agent/user-policy评估、交割压力情景 | MCP尚未暴露；新可执行prepare必须强制引用同一证据/策略评估 |
| `src/sdk/strategies/gather.ts`、`plan.ts` | quote与描述性plan | planFromGathered未传riskReport；旧plan里的market hash使用v1形式，不可直接视为新v2 executable intent |
| `src/sdk/strategies/program.ts`、`strategyRouter.ts` | atomic Leg[]、router费用/权限检查 | 抽出无签名编码/读取路径；gate和router版本必须按目标市场核验 |
| `src/sdk/ratify.ts` | signature与setter、Merkle root/proof、root开关编码 | MCP要明确两种审批方式，不能一律返回EOA签名并忽略contract maker |
| `src/sdk/settler.ts` | 结算ABI、授权、floor、窗口读取 | 先读/预览及准备arm/disarm；keeper执行/JIT属于后续独立功能，不在本轮自动化 |
| `skills/bivium/SKILL.md`、`.claude/skills/bivium/SKILL.md` | 已有业务流程、风险说明及执行边界 | 两份必须同步；MCP工具清单、CLI fallback与能力限制同步更新 |

优先采用同仓分层扩展；不把整个CLI包装成shell工具，不fork一份金融计算逻辑，不在技能Markdown里计算额度。

## 1. 分阶段交付与验收

| 阶段 | 任务 | 完成后可用能力 | 发布验收 |
|---|---|---|---|
| A：可信读取 | 1–3 | 兼容旧工具，完整市场身份、盘口与账户快照、订单/交易状态 | 无私钥可运行；错误不伪装空市场；共享group不重复计深度 |
| B：预览与未签名构建 | 4–6 | 风险评估、借还款/资金/交易预览、钱包可签交易 | prepare必须重读关键状态、风险绑定、模拟通过或只返回前置步骤 |
| C：订单生命周期 | 7–8 | maker订单、setter root、已签名发布、链上取消准备、relayer移除 | prepare无外部写；发布可关闭；未知提交不重复造单；delist不冒充取消 |
| D：做市及套利预览 | 9–10 | 库存压力情景、冷启动深度预览、候选套利净收益分析、skill集成 | 不冒充已锁定利润；不漏算旧单；不启动MM自动循环 |

**最先实现A，再实现B；C、D在相应阶段验收后继续。** 每阶段可独立合入，不需要一次完成所有工具才能交付。远程服务、交易自动签名和MM运行迁移另开计划，不阻塞A/B。

公开可执行目标沿用当前skill：Robinhood testnet 46630。server加载配置后由程序检查，不允许通过工具参数切换任意RPC/Core。4663和历史网络不能产生可执行prepare或publish；测试以注入的内存fixture覆盖历史域，不靠放宽公开入口完成。

## 2. 工具契约

保留 `strategy_list`、`market_list`、`strategy_quote`、`strategy_plan`、`strategy_positions` 名称及旧成功结果形状。旧strategy_plan仍是描述性计划，增加可选的`executable:false`提示，不把它的quoteId当成新prepare凭证。新的查询统一输出下面的envelope；不对五个旧工具强行套一层data而破坏使用者。

所有amount输入为正十进制字符串；拒绝JS浮点金额、科学计数法、hex金额、多余小数、负数。`max`只允许repay/withdraw/claim明确支持的操作，并在快照上解析出精确整数，再绑定到preview；不能在签名前悄悄增大。单位输出同时包含raw、decimals和human；APR明确bps或pct，不混用。

### 新增工具清单

| 工具 | 阶段 | 必要输入 | 主要输出/限制 |
|---|---|---|---|
| `server_info` | A | 无 | 版本、固定profile/domain、支持action/ratifier、relayer写开关、能力限制 |
| `market_details` | A | marketId | 8字段身份、token精度、到期、gate/router能力及费用来源 |
| `book_snapshot` | A | marketId；可选side/limit/cursor | 订单、按group及backing校正的深度、覆盖范围、block和时效；不把静态maxUnits称available |
| `account_snapshot` | A | account、marketIds | wallet余额、escrow、credit、debt、locked/withdrawable collateral、已知挂单敞口及覆盖缺口 |
| `order_status` | A | 完整offer及ratifierData；可选commitment | 重算身份与commitment，链上cap/consumed、授权、到期和relayer可见性分别返回 |
| `transaction_status` | A | txHash | unknown/pending/mined_success/mined_reverted，confirmations，indexer状态可为unknown |
| `risk_assess` | B | marketId、证据、policyId | 评估决策、证据hash、policy hash、风险来源；不接受调用者伪造accept或user-policy |
| `action_preview` | B | action、marketId、account、receiver、操作金额/订单、policyId | 规范化intent、状态前后、成本、风险、模拟结果、previewId、有效期 |
| `action_prepare` | B | previewId | 最新核验后的未签名交易，或审批/授权前置交易；不接任意to/data |
| `order_prepare` | C | marketId、account、side、cap、tick或APR、expiry、ratifierKind、policyId、group模式 | 未签名EIP-712或setter批准步骤、commitment、风险摘要 |
| `order_publish` | C | prepareId、signature或已确认root/proof | 原订单发布状态；需启动时显式开启relayer写，不接受新接收方/金额 |
| `order_cancel_prepare` | C | account、完整offer集合、取消方式 | group消费上限pin或setter root撤销交易，以及受影响订单集合 |
| `order_delist` | C | 完整offer、commitment、取消签名 | 仅移除relayer条目；独立显示onchainCancelled=false/unknown/true |
| `mm_preview` | D | account、marketIds、候选双边订单、policyId | 买边全部成交/卖边全部成交/双边/不成交/到期交割压力情景；不自动报价或补仓 |
| `arbitrage_preview` | D | account、具体候选route、policyId | 按可执行深度/费用/gas估算收益、原子性与库存变化；不扫描无限市场，不广播 |

marketId由market_list/market_details获得，服务端从已知身份重算。可以接受已知id重新解析，不能因重启而要求必须同一会话发现；未知id返回`MARKET_NOT_FOUND`，不据它发明一组市场参数。

### 统一结果与风险语义

在新文件`src/sdk/actions/types.ts`定义，MCP不拥有这套领域类型：

```ts
export type Amount = { raw: string; decimals: number; human: string; token: string };
export type Warning = { code: string; severity: "info" | "warning" | "critical"; message: string };
export type Snapshot = {
  chainId: number; core: string; blockNumber: string; blockHash: string;
  blockTimestamp: string; observedAt: string;
  coverage: "complete" | "partial" | "unknown";
  omitted: string[];
};
export type Result<T> = {
  schemaVersion: 1; data: T; snapshot: Snapshot | null;
  warnings: Warning[]; nextActions: Array<{ tool: string; reason: string }>;
};
export type ToolFailure = {
  code: string; message: string; retryable: boolean;
  field?: string; nextAction?: string;
};
export type UnsignedTx = {
  chainId: number; from: string; to: string; data: string; value: string;
};
export type Prepared =
  | { kind: "ready"; previewId: string; transaction: UnsignedTx; expiresAt: string }
  | { kind: "prerequisites"; previewId: string; transactions: UnsignedTx[]; repreviewRequired: true };
```

这些类型属于计划中的新定义。实际TypeScript内部地址用SDK Address/Hex，JSON边界验证长度/checksum；上面string为线格式。Snapshot=null只用于纯目录等无链数据响应，不能给可执行prepare使用。

MCP成功同时提供JSON text和structuredContent；失败设置isError=true，并提供相同结构的ToolFailure。稳定错误至少包含：`INVALID_ARGUMENT`、`DOMAIN_MISMATCH`、`UNSUPPORTED_ACTION`、`UPSTREAM_UNAVAILABLE`、`PARTIAL_COVERAGE`、`STALE_PREVIEW`、`STATE_CHANGED`、`POLICY_REJECTED`、`POLICY_CONFIRMATION_REQUIRED`、`INSUFFICIENT_BACKING`、`SIMULATION_REVERTED`、`PUBLISH_DISABLED`、`SUBMISSION_UNKNOWN`。非重试错误必须改输入或重新获取状态，不自动反复调用。

## 3. 交易和资金风险约束

1. **无签名者依赖。** prepare只接显式account地址。不能调用BiviumClient.write、TradeClient.executePlan、approveExact或任何会发送交易的方法；不导入wallet.ts，不读取BIVIUM_PK。
2. **不可绕过的绑定。** previewId绑定chain/Core/marketId、account/receiver、action、精确金额、订单commitments与顺序、limits、router、policy/evidence hash、blockHash、expiry。prepare由服务保存的intent重建；输入不能覆盖字段。进程内有界TTL存储即可，重启返回STALE_PREVIEW。preview不是资金reservation，也不是防重复交易的链上nonce。
3. **状态重读。** prepare重新读取consumed、余额、额度、授权、fees、窗口和价格时效。若改变执行路径、金额或风险边界，返回STATE_CHANGED要求新preview。全量key-state一致时才返回最新模拟的交易。
4. **审批是前置步骤。** 缺allowance/grant/root时只返回最小范围前置交易；确认后再次preview/prepare。不能将依赖未落块approval的失败simulation描述为成功，也不默认无限approve。grant需要的位和期限根据route推导，避免给所有操作统一全权限。
5. **程序规则与协议规则分开。** policy拒绝仅表示该工具不构建订单，并不能阻止用户绕过MCP直接调用permissionless core。SDK和MM应复用风险检查；真正要约束签名账户/会话权限，需独立的签名执行层。skill文本和MCP布尔参数都不是资金权限机制。
6. **用户策略来源。** 首版从启动时由用户维护的本地policy文件加载policyId→SelectedRiskPolicy，工具仅选择已加载id。无`accept:true`、`force:true`或传一份伪造accept报告的捷径。确认要求未解决时可输出只读分析，不能返回可签执行数据。
7. **取消不能混淆。** relayer delist不使复制出去的签名失效；group取消会影响同group其他订单；root撤销影响整个root。只依据目标交易成功且链上状态读取一致，报告链上取消成功。
8. **合约版本差异。** 当前SDK已支持collateral-escrow ask，不沿用9月4日报告中旧core的“ask只能卖已有credit”作为通用前提。默认MM预览限制为已有credit的secondary ask；显式策略允许origination时另计债务和抵押风险，且核验目标版本支持。
9. **收益不混算。** 即期买卖价差、到期收益、未实现库存估值分别展示；无可靠换算价格时按token输出，不能相加成USD。费用读取失败不当作0，展示级spot不当作可执行对冲价格。
10. **交易期限的实际保证。** preview expiry是服务端有效期；有deadline的Offer/router应编码链上期限。fund/repay等ABI没有deadline的交易要明确“该到期限制不由此calldata强制”，不得宣称过期后链上不能执行。

## 4. 文件分解

现有`src/mcp/server.ts`保持可导入的兼容门面与main入口，逐步分解，不一次改整个CLI。

| 新/改文件 | 单一职责 |
|---|---|
| 新`src/mcp/schema.ts`、`registry.ts`、`result.ts` | 参数validator、工具注册/dispatch、协议结果转换 |
| 新`src/mcp/tools/reads.ts`、`actions.ts`、`orders.ts`、`mm.ts` | 按领域适配SDK函数，禁止写业务金额计算 |
| 新`src/sdk/actions/types.ts`、`context.ts` | 通用类型、固定部署/显式账户/区块上下文 |
| 新`src/sdk/actions/reads.ts` | 有覆盖范围和block来源的市场/账户/状态查询 |
| 新`src/sdk/actions/preview.ts`、`prepare.ts`、`store.ts` | 规范化intent与风险/模拟、交易构建、TTL记录 |
| 新`src/sdk/actions/orders.ts`、`orderJournal.ts` | 未签名订单、取消构建、准备/发布状态记录 |
| 新`src/sdk/marketMaking.ts`、`arbitrage.ts` | 纯库存情景与候选交易净收益分析，注入外部价格/route |
| 改`src/sdk/client.ts`、`trade.ts`、`strategyRouter.ts` | 抽取账户独立的读取/编码/preflight，执行方法复用新组件 |
| 改`src/sdk/orderbook.ts` | 修复共享group和共享backing的多单规划语义 |
| 改`src/sdk/strategies/gather.ts`、`plan.ts` | 明确描述性plan边界；新执行路径强制canonical v2身份和risk绑定 |
| 改`src/sdk/index.ts`、`package.json`、`package-lock.json` | 公共导出和运行依赖；保持`./strategies`纯入口无Node依赖 |
| 改README、两份SKILL；新`skills/bivium/references/mcp.md` | 工具清单、生命周期和安全示例 |

## 5. 实施任务

以下每个任务作为一个小PR边界。实现时按“写失败测试→验证失败→最小实现→验证通过→提交本任务文件”推进；不在本次计划编写过程中执行这些步骤。每个代码块给出该任务必须落地的契约或核心算法，其余由列出的测试案例约束，不以改测试期望来掩盖行为差异。

### Task 1：协议边界、校验与打包基础

**Files:** 改`src/mcp/server.ts`、`package.json`、`package-lock.json`、`test/mcp.test.ts`；新`src/mcp/schema.ts`、`registry.ts`、`result.ts`、`test/mcp-contract.test.ts`、`test/mcp-stdio.test.ts`。

- [x] 给现有5工具逐个加入输入负例：unknown field、array代object、错误地址、金额number、fractional maturity、非有限数字；保留旧成功字段快照。断言工具参数错误是isError而非进程退出。
- [x] 执行`npx tsx --test test/mcp.test.ts test/mcp-contract.test.ts`，确认新负例在当前实现中失败；记录具体案例。
- [x] 增加Ajv运行依赖并统一注册，核心配置为：

```ts
import Ajv from "ajv";
const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false });
export function validator(schema: object) { return ajv.compile(schema); }
export const decimalAmountSchema = { type: "string", pattern: "^(0|[1-9][0-9]*)(\\.[0-9]+)?$", maxLength: 100 };
```

  schema用于格式，SDK parseAmount后再验证>0与token精度；旧priceWad/aprBps整数规则保持明确。拒绝任意路径、URL、privateKey、keyFile、calldata字段。registry仍导出TOOLS和createStrategyMcp兼容测试。旧测试中的“工具数量恰好5个”改为分别断言五个legacy名称及完整新清单，旧工具返回字段测试不放宽。新增工具用Result；旧工具形状保留。tools/list包含readOnly/destructive/idempotent提示但不以注解代替校验。
- [x] stdio限制单条输入1MiB（在累积无限长一行前截断，不能只在readline完成后检查）、限制列表和输入数组；正常请求预算30秒，模拟60秒，外部读8秒，并发RPC上限8。新context的AbortSignal向下传播；老路径未接入前也须标明能力，不声称已取消底层请求。诊断只到stderr。
- [x] 运行`npx tsx --test test/mcp.test.ts test/mcp-contract.test.ts test/mcp-stdio.test.ts`及`npm run typecheck`；测试分包输入、超长输入、超时后新请求仍可处理。验证bin在`npm install --omit=dev`的临时安装内能启动：tsx须移入dependencies或产出编译入口，本计划选择前者。提交`refactor(mcp): validate and bound tool requests`。

### Task 2：canonical identity与可信读取

**Files:** 新`src/sdk/actions/types.ts`、`context.ts`、`reads.ts`、`src/mcp/tools/reads.ts`、`test/mcp-reads.test.ts`；改`src/sdk/client.ts`、`src/mcp/server.ts`。

- [x] 编写fixture覆盖：同token不同gate/allowPartialRepay生成不同id；传错chain/Core拒绝；RPC失败不返回[]；半数市场读取失败保留成功数据但coverage=partial。
- [x] 跑`npx tsx --test test/mcp-reads.test.ts`确认失败，然后实现server_info/market_details/account_snapshot/order_status/transaction_status。新读取使用公共client和明确account，无签名账户getter。

```ts
export type ReadContext = {
  chainId: number; core: `0x${string}`; account: `0x${string}`;
  blockNumber: bigint; blockHash: `0x${string}`; timestamp: bigint;
};
// context.ts：从已验证profile及latest block建立一次上下文；读合约显式使用blockNumber。
// reads.ts：资产精度从已验证profile/链上读取；市场8字段重算id并与请求比较。
```

  market_list增加非破坏性完整domain与allowPartialRepay字段、filters/limit/cursor；cursor绑定filter+domain。marketIds数组上限20、每页默认20最大100，客户端不能提交无限scan。从API获得的数据标注其自身时间和来源，不能贴成链上同block快照。
- [x] transaction_status只查状态，不长时间等待。unknown可能是RPC不知道，不等同reverted；mined_success也不等同indexer已同步。order_status并列显示链上可执行性与relayer可见性，不将consumed到cap自动判断为“用户取消”。
- [x] 运行`npx tsx --test test/mcp.test.ts test/mcp-reads.test.ts test/lineage.test.ts`与typecheck；提交`feat(mcp): expose verified market and account reads`。

### Task 3：盘口可执行容量，先消除共享额度重复计算

**Files:** 改`src/sdk/orderbook.ts`、`trade.ts`；新`test/group-capacity.test.ts`；改`test/orderbook.test.ts`、`test/trade.test.ts`、`src/sdk/actions/reads.ts`。

- [x] 新测试给同maker/group两个maxUnits=250的订单，未消耗时请求500，规划总量应<=250；已消耗100时总量<=150。独立group两档可在backing允许时合计500。混合maxAssets/maxUnits的同group拒绝作为可执行计划，保留诊断。
- [x] 跑`npx tsx --test test/group-capacity.test.ts`确认当前按entry独立扣容量的逻辑失败，再在扫单过程中按maker/group维护本次虚拟消耗。

```ts
export function groupAvailable(cap: bigint, consumedOnchain: bigint, consumedInPlan: bigint): bigint {
  const used = consumedOnchain + consumedInPlan;
  return cap > used ? cap - used : 0n;
}
```

  每档用**该Offer cap**减同group累计消耗，不把cap简单取sum。amount在group选择的币种计量；assets-capped ask用ceil(cost)、bid用floor(cost)。同时按market/maker维护共享escrow、credit和可发行collateral，不让不同group重复花同一backing。同一group的cap大小不同需分别测试。
- [x] book_snapshot分别显示raw advertised depth与conservative executable depth；虚拟成交顺序来自价格优先排序。订单集合分页不全时coverage=partial，不得据一页证明全账户可执行总量。RPC consumed未知使执行规划不可用。
- [x] 运行`npx tsx --test test/group-capacity.test.ts test/orderbook.test.ts test/trade.test.ts test/mcp-reads.test.ts`及typecheck；提交`fix(sdk): budget sweeps across shared offer groups`。

### Task 4：风险评估、preview记录与prepare绑定

**Files:** 新`src/sdk/actions/store.ts`、`preview.ts`、`src/mcp/tools/actions.ts`、`test/mcp-preview.test.ts`；改`src/sdk/strategies/gather.ts`、`plan.ts`。

- [x] 新测试：不存在policyId拒绝；错误market/evidence hash拒绝；require_user_confirmation无可执行数据；换receiver、金额、chain、quote order、expiry均使preview失配；过期/重启记录返回STALE_PREVIEW。
- [x] 跑`npx tsx --test test/mcp-preview.test.ts`确认失败。实现risk_assess与action_preview；用已有assessRisk/stress，policy只能从启动配置选择，不能把tool传入的accept报告当信任源。

```ts
export type ActionName = "fund" | "repay" | "withdraw_liquidity" | "withdraw_collateral"
  | "claim" | "escrow_collateral" | "withdraw_collateral_escrow"
  | "borrow" | "buy_dcn" | "sell_dcn" | "strategy_program";
export type PreviewBinding = {
  version: 1; chainId: number; core: string; marketId: string;
  account: string; receiver: string; action: ActionName;
  intentHash: string; policyHash: string; evidenceHash: string;
  blockHash: string; expiresAt: string;
};
```

  intentHash使用稳定ABI/规范编码，绑定各action schema所有经济字段；不hash任意JSON键序。新id明确不同于legacy strategy quoteId。store最多1000条，超时最多60秒，先进先过期；批量准备请求仍不等于预留资金。
- [x] 规范各action schema，拒绝未用字段。legacy strategy_plan只输出描述性数据；新构建器不接受它的计划直接转calldata。旧v1经济hash留给原pure策略分析，用full v2 marketId绑定新执行域，两者不互称相同id。
- [x] 运行`npx tsx --test test/mcp-preview.test.ts test/risk.test.ts test/strategies.test.ts test/mcp.test.ts`与typecheck；提交`feat(mcp): bind previews to verified intent and risk policy`。

### Task 5：基础借还款/资金操作的未签名构建

**Files:** 新`src/sdk/actions/prepare.ts`、`test/mcp-prepare.test.ts`；改`src/sdk/client.ts`、`src/mcp/tools/actions.ts`。

- [x] 新测试：public client + 地址可prepare，没有wallet依赖；fund缺approval只返回prerequisites；repay读取精确债务且尊重allowPartialRepay；成熟时新borrow/repay按目标合约拒绝，claim依据真实链状态；准备过程绝不调用writeContract/sendTransaction。
- [x] 跑`npx tsx --test test/mcp-prepare.test.ts`确认失败。先实现fund、repay、withdraw_liquidity、withdraw_collateral、claim、escrow_collateral、withdraw_collateral_escrow。从client.ts现有方法抽出ABI参数构造，并由旧write方法复用，避免两套编码。

```ts
import { encodeFunctionData } from "viem";
// 构建边界：abi和函数名来自已验证的内部action registry，不从MCP输入接收。
export function unsignedCall(chainId: number, from: `0x${string}`, to: `0x${string}`,
  abi: readonly unknown[], functionName: string, args: readonly unknown[]) {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  return { chainId, from, to, data, value: "0" };
}
```

  签名前模拟使用publicClient.simulateContract({account: address,...})；缺token approval返回精确额度approval并要求重preview，不先调用approveExact。取款不得复用借款“总抵押”字段，分别处理可提款余额。claim输出两种可能资产及rounding，不承诺只返loan token。
- [x] key-state在preview和prepare间变化，返回STATE_CHANGED；所有prerequisite与ready payload用decodeFunctionData反解测试，核对receiver、amount、spender、domain，确保没有任意call逃逸。
- [x] 运行`npx tsx --test test/mcp-prepare.test.ts test/sdk.test.ts test/lineage.test.ts`及typecheck；提交`feat(sdk): prepare lending transactions without a signer`。

### Task 6：吃单、借款与atomic program接入

**Files:** 改`src/sdk/trade.ts`、`strategyRouter.ts`、`src/sdk/actions/prepare.ts`；新`test/mcp-trade-prepare.test.ts`；改`test/strategyProgram.test.ts`。

- [x] 测试buy/sell方向、ask escrow origination与secondary credit区分、卖出自有credit不能意外产生债务、gate强制router、fee读取失败、self-deal、跨市场sweep、过期报价和group累计额度。
- [x] 跑`npx tsx --test test/mcp-trade-prepare.test.ts`确认失败；把TradeClient.private preflight拆成可注入account和block的公共只读核验，旧executePlan调用同一核验。

```ts
// 新边界的数据结构：顺序是执行含义，不能sort后改变交易。
export type FillIntent = {
  account: `0x${string}`; receiver: `0x${string}`;
  marketId: `0x${string}`; side: "buy_dcn" | "sell_dcn" | "borrow";
  fills: Array<{ commitment: `0x${string}`; units: bigint }>;
  maxCost?: bigint; minProceeds?: bigint; deadline: bigint;
};
```

  borrow采用目标gate许可路径；不能为了复用core multicall绕过费用/路由要求。`strategy_program`调用既有Leg[] builder，核验router、MAX_LEGS、授权及minOut等限制，只返回经过模拟的一次执行交易。没有兼容router时，拒绝atomic-only请求；可读plan仍可显示sequential并明确风险。
- [x] 区分链上限制与交易后观察：TradeClient执行后检查余额delta的throw不能回滚已挖矿交易。prepare结果只把合约真正强制的minOut/maxCost等列为onchainConstraints，额外delta核对列为postExecutionChecks。
- [x] 运行`npx tsx --test test/mcp-trade-prepare.test.ts test/trade.test.ts test/strategyProgram.test.ts test/strategyRouter.test.ts`及typecheck；提交`feat(mcp): preview and prepare bounded DCN execution`。

### Task 7：maker订单与取消准备

**Files:** 新`src/sdk/actions/orders.ts`、`src/mcp/tools/orders.ts`、`test/mcp-orders.test.ts`；改`src/sdk/ratify.ts`仅当需导出已存在的编码组件。

- [x] 测试两个ratifier分支：signature输出digest与ratifyDigest一致；setter输出真实root/proof及未签名批准交易。contract maker不能落入EOA-only签名路径。side、cap、expiry、chain/Core被改动，commitment必须变化。
- [x] 跑`npx tsx --test test/mcp-orders.test.ts`确认失败；实现order_prepare/order_cancel_prepare，复用adapter、resolveRatifier、buildOfferTree、setRootRatifiedCalldata。

```ts
export type GroupMode =
  | { kind: "independent" }
  | { kind: "shared"; group: `0x${string}`; budgetUnit: "face" | "loan_assets" };
// independent每档分配不同group；shared显式声明替代订单预算，不承诺各档数量可加。
```

  默认遵循profile ratifier选择，不因MM偏好就静默改为signature。secondary ask按已有credit；新增债务只有在政策允许、目标支持且模拟/压力测试覆盖时开放。prepare本身不fund、不setRatifier、不flag root。
- [x] 取消必须显示作用范围；同group未知更高cap的订单不能声称全组已取消。取消给定集合时pin到集合最大cap；若要求全group永久失效可准备uint256最大值pin并明确永久性。root off显示所有关联订单；签名取消与setter撤根是不同动作。
- [x] 跑`npx tsx --test test/mcp-orders.test.ts test/ratify-setter.test.ts test/lineage.test.ts`及typecheck；提交`feat(mcp): prepare maker orders and authoritative cancellation`。

### Task 8：受控relayer发布与不确定结果恢复

**Files:** 新`src/sdk/actions/orderJournal.ts`、`test/mcp-publish.test.ts`；改`src/sdk/actions/orders.ts`、`src/sdk/relayer.ts`、`src/mcp/tools/orders.ts`。

- [x] 新测试：默认PUBLISH_DISABLED；篡改签名/offer拒绝；domain/ratifier/maker核验；setter未批准不能发布；POST服务端接受但响应丢失时记录unknown；重试保持同commitment；delist成功不等于链上取消。
- [x] 跑`npx tsx --test test/mcp-publish.test.ts`确认失败。服务启动显式`--allow-relayer-writes`才注册或启用写工具。order_publish只接受服务已记录prepareId和外部签名/proof，发送前重核签名、backing、有效期和风险预算；持久化完整公开签名订单，不持有私钥。

```ts
export type PublishState = "prepared" | "signed" | "publishing" | "published" | "submission_unknown" | "rejected";
export type PublishRecord = {
  version: 1; commitment: string; prepareId: string; state: PublishState;
  account: string; chainId: number; core: string; updatedAt: string;
};
```

  journal写入使用临时文件+atomic rename，限定单写进程并使用锁文件；锁冲突明确失败，不能两个server覆盖状态。日志目录启动配置，工具不能选任意文件路径。发布前write-ahead记publishing；超时保留signed payload和submission_unknown，用完整身份查询relayer，绝不新建不同expiry替代重试。
- [x] 每次返回都区别accepted_by_relayer、onchain_fillable、filled三种含义。第三方已经取得签名时，即使publish被本地拒绝也不能声称签名失效。journal记录未撤签名用于风险预览，进程故障不丢潜在负债。
- [x] 跑`npx tsx --test test/mcp-publish.test.ts test/relayer.test.ts test/mcp-orders.test.ts`及typecheck；提交`feat(mcp): relay signed orders with recoverable publication state`。

### Task 9：可控库存下的冷启动做市预览

**Files:** 新`src/sdk/marketMaking.ts`、`src/mcp/tools/mm.ts`、`test/mm-preview.test.ts`；改`src/sdk/actions/reads.ts`、`orders.ts`。

- [x] 建立完全离线的库存fixture：初始credit=100、买入face=60、卖出face=40，则买边全成credit=160，卖边全成credit=60，双边全成credit=120；现金分别按真实tick与maker方向取整。限额150时买边情景必须拒绝，无论双边情景是否合格。
- [x] 跑`npx tsx --test test/mm-preview.test.ts`确认失败。新增纯函数按token计算情景，输入必须包含已有有效订单与新候选订单，不从单轮LEVEL_FACE推导全账户风险。

```ts
export type InventoryCase = "none_filled" | "bids_filled" | "asks_filled" | "both_filled";
export function creditAfter(credit: bigint, bought: bigint, sold: bigint): bigint {
  return credit + bought - sold;
}
```

  上式用于纯secondary；对origination ask另计算issued、debt与locked collateral，不能把负credit当有效仓位。每个情景使用Task3 group/backing分配；价格、期限和交割压力分别展示。全账户限额按token/market/期限桶，不盲加不同token。
- [x] policyId绑定库存最大值、单市场投入、最大新增债务、最低现金保留、单次做市损耗预算。初期不提供“每日实际损失已受控”保证，因为尚无完整PnL账本；展示未知并禁止依赖该保证的执行模式。
- [x] completeness必须诚实：relayer+本server journal不一定覆盖钱包在别处签的订单。coverage不完整时可分析已知集合，不能给全账户safe verdict；若要在工具内强制全账户限额，要求受控签名来源及可核验完整订单登记，另部署时验证。预览不是资金锁，两个同时生成的安全preview合在一起可能超额。
- [x] 空盘口可返回冷启动双边候选评估，标为`inventory_backed_market_making`，不要求存在另一套利腿；收益为情景估计。超过库存限额时给出缩量/单边/暂停的原因，不自行扩大policy。
- [x] 跑`npx tsx --test test/mm-preview.test.ts test/group-capacity.test.ts test/mcp-orders.test.ts`及typecheck；提交`feat(sdk): preview cold-start market making inventory risk`。

### Task 10：套利候选分析、skill接入与最终验收

**Files:** 新`src/sdk/arbitrage.ts`、`test/arbitrage-preview.test.ts`、`skills/bivium/references/mcp.md`；改`src/mcp/tools/mm.ts`、`src/sdk/index.ts`、README、两份SKILL、`test/skill-sync.test.ts`、`test/package-surface.test.ts`。

- [x] 测试净收益：同numeraire退出106、进入100、路由费用2、gas预算1时net=3；minProfit=4不达标。任一fee、gas换算、深度或执行价格未知，netProfitLowerBound=null，不补0。自家订单互相成交和不同到期/交割资产的“相同DCN”不能当无风险价差。
- [x] 跑`npx tsx --test test/arbitrage-preview.test.ts`确认失败。实现仅对明确候选route分析，不做无限套利扫描：

```ts
export type OpportunityKind = "estimated_spread" | "atomic_candidate";
export function netAfterCosts(proceeds: bigint, entry: bigint, fees: bigint, gasBudget: bigint): bigint {
  return proceeds - entry - fees - gasBudget;
}
```

  调用方adapter必须声明entry/proceeds是否已含fee；统一规范后再调用该函数，禁止重复扣费。atomic_candidate要求一次已验证程序并通过模拟；仍不能声称保证盈利。只有合约实际约束的amount/minOut/minProfit可列为硬保护；gas仍是预算。没有链上净利润约束时标为estimate，不用“locked arbitrage”。
- [x] 更新skill引用mcp.md，保留用户意图、testnet、逐笔钱包签名、风险来源及交割说明；加入三个完整流程：借贷预览→钱包签名，冷启动mm_preview→order_prepare，已签单发布→状态→链上取消准备→delist。能力缺失时退回CLI的preview路径，不能因为MCP没有工具就自动执行CLI交易。
- [x] 更新README列全5个旧工具与新增工具，明确“无链上发送/签名”仍成立，但可选relayer写不再是纯read-only。同步skill-sync测试对应文案。纯`@bivium/cli/strategies`入口不导出store/journal/context；新actions经根SDK导出，避免Node依赖污染Worker使用的pure子路径。
- [x] 最终运行`npm run typecheck`、`npm test`、`npm pack --dry-run --json --ignore-scripts`；检查tarball包含bin、src、skill引用资源和运行依赖。用真实stdio子进程完成initialize→tools/list→market read fixture→preview→prepare fixture；MCP工具测试中任何网络写或wallet调用直接报错。提交`docs(mcp): document lending and inventory-aware agent workflows`。

## 6. 阶段验收用例矩阵

| 场景 | 必须观察的结果 | 对应任务 |
|---|---|---|
| 输入错误/主网prepare | 明确不可重试错误；无可签数据 | 1、2、4 |
| 无流动性冷启动 | 可评估用户价格双边挂单，标明未成交不产生收益 | 9 |
| relayer故障 | unavailable而不是empty book | 2、3 |
| 两档同group | 深度不重复计额度；混合cap币种拒绝 | 3 |
| 买边全成交超库存 | 双边平均风险低也不能掩盖单边越限 | 9 |
| 外部旧签名集合未知 | coverage不全，不输出全账户safe | 8、9 |
| preview后订单被吃掉 | prepare要求重新预览 | 4、6 |
| allowance/root未完成 | 只返前置步骤；无资金转移 | 5、7 |
| 费用RPC失败 | 不按0费给利润结论 | 6、10 |
| POST响应丢失 | submission_unknown，同commitment恢复 | 8 |
| delist成功 | 不称链上取消；有效签名继续计风险 | 7、8 |
| 模拟通过但未来报价变化 | 明确快照限制及合约实际保护，不保证成交/利润 | 4、10 |
| SDK账户独立prepare | 只读client+地址可构建，wallet间谍调用数=0 | 5、6 |
| Legacy MCP客户端 | 五工具旧字段仍可解析 | 1、10 |
| npm生产安装 | bin可以启动，skills引用存在 | 1、10 |

## 7. 可直接落地的核心测试骨架

下面使用任务中已定义的纯函数，均是计划中的测试代码，不是本次新增的实现。实现时放入各自任务的测试文件，再补齐其依赖读取/模拟fixture；纯函数断言不能替代上面的端到端验收。

`test/group-capacity.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { groupAvailable } from "../src/sdk/orderbook.ts";
test("same group shares onchain and in-plan consumption", () => {
  assert.equal(groupAvailable(250n, 100n, 0n), 150n);
  assert.equal(groupAvailable(250n, 100n, 150n), 0n);
  assert.equal(groupAvailable(50n, 100n, 0n), 0n);
  assert.equal(groupAvailable(500n, 100n, 150n), 250n);
});
```

`test/mm-preview.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { creditAfter } from "../src/sdk/marketMaking.ts";
test("single-sided fills must not be hidden by balanced fills", () => {
  const limit = 150n;
  assert.equal(creditAfter(100n, 60n, 0n), 160n);
  assert.equal(creditAfter(100n, 0n, 40n), 60n);
  assert.equal(creditAfter(100n, 60n, 40n), 120n);
  assert.ok(creditAfter(100n, 60n, 0n) > limit);
});
```

`test/arbitrage-preview.test.ts`：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { netAfterCosts } from "../src/sdk/arbitrage.ts";
test("spread must clear fees and gas budget", () => {
  assert.equal(netAfterCosts(106n, 100n, 2n, 1n), 3n);
  assert.ok(netAfterCosts(106n, 100n, 2n, 1n) < 4n);
  assert.equal(netAfterCosts(101n, 100n, 2n, 1n), -2n);
});
```

`test/mcp-contract.test.ts`的格式边界用例：

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { validator, decimalAmountSchema } from "../src/mcp/schema.ts";
test("tool amounts are explicit decimal strings", () => {
  const validate = validator({ type: "object", required: ["amount"],
    properties: { amount: decimalAmountSchema }, additionalProperties: false });
  assert.equal(validate({ amount: "10.5" }), true);
  for (const value of [{ amount: 10.5 }, { amount: "1e5" },
    { amount: "-1" }, { amount: "0x10" }, { amount: "1", force: true }]) {
    assert.equal(validate(value), false);
  }
});
```

## 8. 本计划的明确边界

本轮的“借鉴Aave”是让协议能力可查询、可预览、可构建、可核对，不接入Aave借款作为MM资金来源，不新增自动套利执行器，不托管资金，不承诺常驻监控。借Aave资金、跨DEX路由、每日PnL账本、多进程预算锁和签名权限管理是独立项目，应在这些底层接口成熟后另行设计。

实施时如发现目标合约缺某个action/ratifier能力，工具返回UNSUPPORTED_ACTION，并在server_info列出限制；不得临时换合约、换网络或绕过gate使测试通过。候选策略和业务风控不会变成Core管理员或协议许可名单。

**计划完成标准：** 每项新增工具有对应SDK责任、输入输出契约、无签名/有副作用边界及失败场景；实施可按A→B→C→D逐阶段验收。本次产物只新增这份计划，不修改MCP、SDK、skill或运行配置。


## 实现记录（2026-09-09）

实现位于 `feature/mcp-expansion`，独立 worktree `.worktrees/mcp-expansion`。20 个工具保留旧五工具接口；CLI、SDK、MCP 与 skill 同仓库。

验收细化与保守边界：

- MM 对所有未过期的已知订单计入库存，包括未来 start；额外检查不同成交顺序、单张订单和共享额度。无法证明分片成交取整上界或共享替代组合时，预览为 incomplete，订单准备/发布拒绝依赖该不完整上界。
- 订单准备串行到 journal 插入；发布重新检查政策及已知库存。relayer 与 journal 仍不能覆盖所有外部签名，不提供账户全局 safe verdict。
- 目前新 origination 挂单不开放；prematurity secondary-only sell 在缺少链上硬约束时拒绝。borrow 限制为零 taker credit，避免混合转让/新增债务歧义；strategy program 为已验证的单市场单 fill 开仓路径。
- MCP arbitrage adapter 只输出 estimated_spread；费用、深度和原子程序未验证时净收益下界为 null。纯 SDK atomic_candidate 还要求已模拟程序与非负链上利润下限证据。
- journal 为单写者持久日志，最多 1,000 条且不自动删历史；普通 SIGINT/SIGTERM 等待当前操作收尾后释放锁，进程崩溃/SIGKILL 仍需人工检查旧锁。
- 默认发布错误码 PUBLISH_DISABLED；外部钱包负责全部签名和链上发送。取消支持旧外部订单，不套用新挂单的提前到期限制。relayer 删除不等于链上取消。
- 原先计划的原子套利验证、完整账户签名登记、每日 PnL 和借贷新增抵押套利不在当前可执行能力中，文档明确保留后续工作，不宣称通过快照解决。

校验包括纯函数边界、真实 SDK 公共模拟、网络/钱包禁止的 stdio 子进程流程、普通停止重启、npm 打包以及 omit-dev 生产安装启动；全部使用离线 fixture 或本地 HTTP stub，未使用真实账户签名，未进行链上发送或生产 relayer 写入。
