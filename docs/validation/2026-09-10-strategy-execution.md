# 测试网策略交易验收

后续 short/leveredLong 已完成开仓，见 [借入策略实测](2026-09-10-strategy-borrow.md)。以下保留前次借出策略验收记录。

2026-09-10，用户提供 gas 并授权 mint、钱包授权与策略交易后，使用账户 `0xCc90b98499214Fb29EC6918697817e639318c046` 在 chain 46630 实测。每个策略 size=1、maxInput=1，授权仅给所需额度。

## 成交结果

| 策略 | 钱包实际支出 | credit 增量 | 结果 |
| --- | --- | --- | --- |
| lendAsset | 0.997429345182452551 mCASHCAT | 1 mCASHCAT 面额 | 授权、重新预览、prepare、执行、回执及仓位验证通过 |
| lendQuote | 0.99748 bUSD | 1 bUSD 面额 | 同上 |
| short | 0 | 0 | INSUFFICIENT_LIQUIDITY；没有有效 bid，未发送交易 |
| leveredLong | 0 | 0 | INSUFFICIENT_LIQUIDITY；没有有效 bid，未发送交易 |

lendAsset 授权：`0x60ca47015fdd4973fdb87ee1682f8e7d2228a90ce16ecf2976eba7736b3c9ab2`

lendAsset 执行：`0xb210530332e826c868543a869d1f2daf777aa5cdd15a2516af9e7a647200e7d7`

lendQuote 授权：`0x1b8dea4fbadac2b959fa35df1c7a551550c9492177e1aa8b56cb493674059fbe`

lendQuote 执行：`0x759574b46e71f1bdcfa16c664014aa3a2ca05723c59dd5ac9f5ac6533edf75a8`

四笔回执均 success。最终余额为 9.002570654817547449 mCASHCAT、9.00252 bUSD；这两种代币对实际 gate router 的剩余 allowance 均为 0。

## 实测范围及异常处理

- 实际通过 `createStrategyMcp.handle` 调用 strategy_preview/action_prepare，使用默认真实 RPC、relayer、spot 和链上状态，无数据注入或状态覆盖。
- 钱包签名在独立验收脚本完成；MCP 本身仍不读取私钥、不签名、不广播。发送前重新 eth_call、估算 gas、检查链 ID、from、目标、函数、零原生币 value、额度与过期时间。
- 测试仅针对用户刚 mint 的 mock token。使用进程内临时 `testnet-acceptance` 策略：允许 arbitrary mint 和未知风险证据，仍拒绝已知不可卖资产。明确记录 mintable=true；没有伪造缺失证据，仓库默认保守策略未改动。
- lendAsset 成交后的首次验收快照受最新区块缓存/读取时序影响，读到了成交前状态，脚本立即停止。随后在 receipt.blockNumber 精确读取，确认 credit 增量正确；后续脚本使用成交区块做检查，没有重复下单。
- lendQuote 授权后首次重新预览遇到 spot 服务不可用；未发送策略交易。新鲜重试成功后使用已有足额授权完成一笔执行。
- 本次通过的是两个借出策略的开仓流程；借入策略、到期 claim、repay/withdraw 仍未完成真实交易验收。

详细公共链上证据见 [JSON](2026-09-10-strategy-execution-evidence.json)。此前只读验收见 [记录](2026-09-10-strategy-live.md)。
