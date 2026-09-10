# 四个首发策略：真实盘口验收记录

后续用户授权的真实测试网交易结果见 [交易验收](2026-09-10-strategy-execution.md)；以下保留首次只读探测记录。

时间：2026-09-10 16:05–16:08 UTC。代码：af955b5（PR #41 初始实现）。

## 结论

真实 RPC、市场索引、签名订单解析、链上订单背书、gate 路由和费用读取可用。**四个策略的真实账户端到端验收尚未完成**；没有签名、广播、资金转移或链上状态修改。

| 策略 | 输入及实际结果 | 尚未通过的阶段 |
| --- | --- | --- |
| lendAsset | mCASHCAT，面额 1，buffer 29.5337%；找到有效 ask；实际总支出 0.997377696129047149 mCASHCAT | 默认保守风险策略要求补充证据/确认，previewId 为 null；未进入钱包模拟和 prepare |
| lendQuote | mCASHCAT 信用市场，bUSD 面额 1，buffer 27.4611%；找到有效 ask；实际总支出 0.99748 bUSD | 同上 |
| short | mCASHCAT，借入面额 1，buffer 29.5337% | INSUFFICIENT_LIQUIDITY：所选市场没有 bid |
| leveredLong | mCASHCAT，持仓规模基准 1，buffer 27.4611% | INSUFFICIENT_LIQUIDITY：所选市场没有 bid |

四次调用均使用 maturity `1789372800`、maxInput `1`、slippageBps `100`；借入策略 maxPriceImpactBps `500`。金额用于只读验收，不是交易建议。risk policy 是原始 DEFAULT_POLICY_SELECTION，evidence 为空，没有伪造风险证据或放宽策略。诊断账户为 `0x000000000000000000000000000000000000dEaD`，不是用户钱包。统一使用 collateralKind `meme` 的诊断输入；实际 lendAsset 的抵押品是 bUSD，后续账户验收应按实际抵押品填写分类和证据。

## 链上及盘口证据

- 市场索引返回 40 个市场；客户端逐项校验 canonical market ID。索引 confirmedThrough 为 116952537；它落后于链头，因此索引健康标识不能视为链头完整性证明。
- maturity 1789372800 的六个 mCASHCAT/bUSD 双向市场共读到 14 个签名 ask、0 个 bid。链上 consumed 为 0，maker credit 为 0，但 collateral escrow 足以支持所测试 ask 的抵押发行。Core 中有 liquidity 并不等于存在可供该借入流程消费的签名 bid。
- 实际 gate 为 `0x8115B27543D42006C15DDDE54477c3b985D05197`，解析到 router `0xDeD0545C0F83db95f3D5A674d1Dbc6836F0c2696`；lenderFeeBps=1000 是对折价收益计费，不是面额的 10%。
- 默认 V4 pool（fee=3000，tickSpacing=60，zero hooks）已初始化；区块 116963196 的 in-range liquidity 为 3200000000000000。
- 独立 swap 深度探测：1 mCASHCAT 估计换得 0.292151 bUSD；1 bUSD 估计换得约 3.3998472599 mCASHCAT。这是基于当前区间深度的估算，**没有模拟实际 swap/router 执行**。
- Spot feed 返回 0.193 bUSD/mCASHCAT，与上述池内估价明显不同；真实交易验收应保留这项差异，核对参考价格来源和经济约束。

结构化证据见 [JSON](2026-09-10-strategy-live-evidence.json)。不同探测固定各自区块，并非所有数据来自同一区块；这些订单会随时间变化。

## 继续验收所需条件

1. 提供实际测试网钱包公开地址，以及要使用的既有风险策略/可信证据。没有读取任何私钥。
2. short/leveredLong 对应市场需要存在有效且有资金背书的签名 bid。未自动发布或伪造订单。
3. 使用新鲜盘口重新调用 strategy_preview；接受风险筛查后，才执行 action_prepare。
4. 若返回 prerequisites，由钱包完成授权并确认 receipt，再重新预览。只有 ready 且最终调用模拟成功，才可认定未签名交易准备流程通过。
5. 实际成交、receipt、仓位变化及 claim/repay/withdraw 的生命周期验证仍待小额交易授权与执行。

## 已完成的软件验证

本次重新执行 typecheck、389 个测试和 diff 检查均通过。PR 初始提交的 GitHub CI 通过。无真实账户模拟或成交成功的声明。
