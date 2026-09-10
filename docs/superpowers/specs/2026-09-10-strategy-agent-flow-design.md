# 首发策略的 agent 调用闭环

用户已要求打通 lendAsset、lendQuote、short、leveredLong。保留五个旧工具和底层 action/order 工具；新增 strategy_preview 将高层意图解析为现有 ActionService 可验证的精确行动。比让模型拼 fills/poolKey 更可靠，也不建立第二套交易执行引擎。

输入包含 strategy、asset、size（沿用旧报价：lendQuote 为报价资产 face，short/lendAsset 为资产 face，leveredLong 为抵押资产 holding）、maturity、bufferPct、account、maxInput（lend 为 loan token 总支出上限，borrow 为 collateral token top-up 上限）、slippageBps、policyId、collateralKind、evidence。swap 策略另要求 maxPriceImpactBps。所有金额为 human decimal strings，转换使用区块内读取 decimals。receiver 固定 account。不得输入 URL、私钥、fills、poolKey 或 calldata。

SDK 从可信 profile 的 token 名称与 canonical market index 解析市场，使用 fresh spot 和已有 resolveStrategy；超出 rung tolerance 或 stale spot 拒绝。只选择一个足以覆盖完整请求的订单；没有流动性返回明确错误并建议重新报价/缩量或另选挂单流程，不静默切换。读取两种 ratifier 订单，验证身份、期限、group、backing；ActionService 完成 ratification、simulation 与 prepare 重验。

swap 使用 host 配置的候选 v4 pools（默认沿用 CLI 的 fee3000/spacing60/no hooks，但须读取验证），读取同一区块的 StateView/Quoter，要求 depth-aware 数据，不以 marginal pool-price 代替深度。按用户 slippage 和 impact 上限构造 minOut，扣除真实 router fee 后计算输入，top-up 不超过 maxInput。gate 决定可用 router；直接 lender fill 不强行收费路由。

返回 source request、已选市场、精确金额/费用、swap 依据、indicative payoff（不含费用，明确标注）、风险判断和现有 previewId。ActionService 在同一 snapshot 评价并绑定 sourceHash、完整 fills 和交易限制，prepare 不重新选订单；状态变化要求重做策略预览。前置审批只返回 prerequisite，外部钱包完成后重新 strategy_preview。不会自动签名、链上发送或挂单。

目录添加逐策略能力和 size/maxInput 单位说明，四策略可 discover→strategy_preview→action_prepare→wallet→transaction_status/account_snapshot。旧报价仍保留为测算；退出通过现有 repay/claim/withdraw primitive，组合退出不是本次新增能力。

验收：四策略真实 SDK/ABI 的 MCP 全流程；费用、混合 decimals、授权前置、空盘口、超库存/限额、错市场、过期/stale、prepare 后被吃单/reorg、拒绝其他策略和未知输入。离线 fixtures 不访问钱包、不开网络写。更新 README/两个 skill references，类型、全量测试、打包与子进程检查。
