# Short / LeveredLong 测试网成交验收

2026-09-10，用户同意创建独立测试 maker 并补充有效 bid 后，完成两个借入策略的真实开仓交易。这是自建对手方的 mock-token 测试，不是外部流动性或套利收益证明。

## 账户、市场和订单

- Taker：`0xCc90b98499214Fb29EC6918697817e639318c046`。
- Maker：`0x9A5487a37288AE594Cd7cA05582f541B09a8C516`；私钥仅保存在本机受限文件中，未提交。
- 从现有 taker 钱包转入 maker 0.0001 测试网 ETH 作为 gas；maker 各 mint 1 mCASHCAT / 1 bUSD，并分别 fund 到对应现有市场。
- 使用 maturity=1789372800 的另两个档位，避免 taker 原有 lending credit 触发“借入须零 credit”保护。short 的 strike 对应 0.2 bUSD/mCASHCAT，buffer≈3.626943%；leveredLong 对应 0.175 bUSD/mCASHCAT，buffer≈9.326425%。
- 两单 tick=4080，有效期 30 分钟，面额分别为 1 mCASHCAT 和 0.175 bUSD。链上 ratifier 注册、资金背书和签名预检通过后发布到真实 relayer。

## 成交结果

| 策略 | 新增债务 | 锁定抵押品 | 钱包变化 |
| --- | --- | --- | --- |
| short | 1 mCASHCAT | 0.2 bUSD | bUSD 增加 0.091215；无钱包 collateral top-up |
| leveredLong | 0.175 bUSD | 1 mCASHCAT | mCASHCAT 减少 0.406455101311104109；低于预览 top-up 上限 0.412390550297993068 |

short 执行：`0x78f03c5c89626de745f7cdda8fd5b7523ada4faf449d5cecd6741ab8ece703bf`

leveredLong 执行：`0x2ca0d669a0c00370a94310462a2e062bcbe034f06d8beb213dd43944e8e3d738`

两笔回执 success，成交区块和最终区块均验证债务/抵押品；maker credit 与 taker 新债务相等。size=1 对 leveredLong 指抵押资产规模基准，不是借入 1 bUSD。

## 实测修复

最初 short 的 CAP_FILL 授权过期时间等于当次 execution deadline。授权上链后新预览按新区块生成更晚 deadline，因此再次要求授权，产生循环。验收脚本在第二次要求授权时停止，没有重复盲签。

修复：新生成的 grant 使用 execution deadline + 300 秒作为有界重预览余量，权限仍仅 CAP_FILL；交易本身的 deadline 和金额约束不变。增加回归测试，覆盖授权上链后 deadline 前移仍可 prepare，以及 grant 过期后仍须续期。修复前测试失败，修复后完整 390 测试通过；真实借入交易也随后通过。

使用同前次验收的进程内临时 mock-token 风险策略，允许 mintable 和未知风险证据。默认保守策略未放宽；MCP 仍只生成未签名数据，由独立钱包脚本核对限额、模拟、签名和广播。

## 清理与剩余仓位

- 两笔 bid 已全额消费，relayer 副本已删除。
- Maker 未使用 liquidity 已全部提回：0.002913670967725389 mCASHCAT、0.82551 bUSD；两个市场 makerLiquidity 均为 0。
- Taker 对 router 的 bUSD、mCASHCAT allowance 均为 0；Core grant 已撤销为 capabilities=0、expiry=0。
- Taker 最终钱包余额：9.093735 bUSD、8.596115553506443340 mCASHCAT。此前的两个 lender credit 和本次两笔 debt/collateral 均保留。
- 四个首发策略的真实测试网开仓流程至此均已通过。还款、取回抵押品、到期 claim 尚未执行；这些仍是存续仓位，不能称为完整退出生命周期通过。

[结构化证据](2026-09-10-strategy-borrow-evidence.json)，最终核验区块 116977005。
