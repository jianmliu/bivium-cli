# Robinhood 测试网 MCP／CLI 兼容性更新

日期：2026-09-25。基线：`origin/main` 的 `640e81e08287e7801cbc0657df2d80ed1d2ddbda`。

## 目标与范围

将 CLI 与 MCP 的默认产品行为对齐到已发布的 Robinhood 测试网前端：mNVDA/bUSD 正反市场、明确标识的 Mock 参考价、市场 Gate 指定的收费路由，以及 CASHCAT 新业务下架但历史退出保留。

本次只做本地代码、测试和文档。PR、合并、npm 分发及 Cloudflare MCP Worker 发布在验收后另行执行；不部署 Core、不修改前端或 MM、不签名、不广播、不注资、不读取钱包私钥或改变权限。

DCN 到期前二级卖出及其收费执行路径不在本次范围内。保留现有防意外新增债务限制；不得为了“对齐 Pro”直接删除该保护。

## 已确认依据

- 最新 MCP 源码调用现有市场索引返回 42 个市场，其中 21 个 CASHCAT 历史市场没有产品下架标识；前端的新业务接口已过滤 CASHCAT。
- SDK `fetchPairRatio` 读取旧 `/spot`：MNVDA-BUSD 返回 170、status=ready，但无源更新时间；独立 `/mock-refill-spot` 返回 225 和 observedAt。
- 月度 mNVDA 市场 Gate 为 `0xBcdf81201D98861bB19C61de97D580cF3E25878A`，其唯一 Router 为 `0xA7DF5C53F9D809DA34eE29E71531F936b3465B9f`。链上 FEE_BPS 和 LENDER_FEE_BPS 均为 1000；这是相应费用基数的费率，不是成交本金的 10%。
- Profile 的 strategyRouter 仍为另一地址。market_details 返回 fees=null、feeSource=unknown，却报告完整 coverage 且无警告；部分底层准备路径会优先选中旧 Router 后拒绝。
- 54 项相关既有测试通过，表明需要补充集成覆盖，不能把旧测试通过当作新市场已兼容。
- 远程 MCP 仅验证了公共 health；上述工具功能核验来自与远端 main 同树的本地源码，不代表已验证线上 Worker 版本。

## 方案选择

推荐在现有 SDK 增加共用的参考价适配、路由准入和产品市场策略，再由 CLI、stdio MCP 与 HTTP MCP 调用。优点是三种入口共用约束和测试，不增加服务。

仅修改 profile/文档不能解决价格过期、路由分歧或下架状态问题。分别在 CLI 与 MCP 添加独立判断会造成行为漂移；本次不采用这两种方式。

## 1. Mock 参考价

- 对 chain 46630、Core `0x2Ff12244e430BE82a8cdb13ee4FaA31777Bda9e4`、mNVDA `0xb0F5bb3028A46Ab101b29A540E304aE3a5bBE877`、bUSD `0x628626de13dd4b5b1cb80d468c261c15df00d717` 的两种方向显式启用独立 Mock 快照适配。不得只凭符号把其他链或资产路由到 Mock。
- 从可信部署配置中的 relayer 基址读取 `/mock-refill-spot`；工具调用参数不得指定任意价格源或提供伪造 observedAt。
- 验证 version=1、pair=MNVDA-BUSD、mock=true、严格正整数 WAD 和合法源时间。未来时间、缺失时间、年龄达到 1,800 秒或超过该值、网络/解析错误均不可用于新交易准备。
- 保留规范的 bUSD/mNVDA WAD；按调用方要求转换方向，使用整数算术，不经浮点往返后生成交易边界。展示数值可格式化。
- 对外附带 mock/source/observedAt/expiresAt 与可用状态。请求时间不得替代源时间；Mock 数据不得标为真实行情，也不得生成所谓真实历史波动率。
- 错误时明确返回不可用或 stale；禁止静默回退旧 170 接口。纯历史查询不依赖该参考价。
- 未配置这项 Mock 的其他部署继续使用既有价格来源；不扩大为全局价格系统重写。

## 2. 按市场 Gate 解析 Router 与费用

- 共用解析器服务于市场详情、策略 preview 与受支持的 unsigned action 准备；以当前市场身份与同一已验证链的固定区块为准读取。
- 非零 Gate：读取并验证 Gate 的 Core、routers 和 LENDER_MUST_ROUTE。配置 Router 只有在 Gate 允许时才能使用；否则仅在存在唯一兼容、通过准入的候选时选择它。多候选无法确定时返回路由选择错误，不盲选数组首项。
- 候选必须有合约代码、BIVIUM 与目标 Core 一致，并提供该动作所需的 ABI/能力和费用字段。费用范围与现有测试网 Pro 的 0–2000 bps 边界一致。Gate 允许不等于支持所有策略；涉及 swap 的能力不得因支持普通 CLOB fill 而自动开启。
- 零 Gate 不任意信任用户传入的 Router；保留已有可信 host 配置限制。读失败不得解释为无需路由或零费率。
- 详情返回实际选择的 Router、费用基数、费率与来源区块。无法确认时返回 unknown、partial coverage 和明确警告，不返回“完整且无警告”。
- 准备阶段绑定并重新验证 Router/Gate/费用和预算；发现变化要求重新 preview。费用由实际 fills 算出，纳入 maxCost/minProceeds 等边界。
- 仍不支持某项收费执行路径的 CLI 命令应在签名/提交前明确报 unsupported；不能回落到直连 Core。本次不新增 DCN 二级成交实现。

## 3. 新业务准入与历史恢复分离

- 保留原始链上市场发现和完整历史目录，不从 profile 删除 CASHCAT Token。
- 产品下架规则只绑定 chain 46630、上述 Core 和 CASHCAT `0x34a456c0365B78c5E04b97dee228207cf9CaB35D`，覆盖其作为借贷任一腿；其他链/Core/同名资产不受影响。
- 对外区分产品状态与期限状态：是否 delisted、是否 matured、是否允许 newBusiness，并给出原因。下架/到期不等于用户没有仓位或不能退出。
- CLI/MCP 面向开仓的市场列表默认仅返回可开展新业务的市场；显式历史/全部查询可读取完整目录，附状态。先筛选再分页，cursor 绑定筛选条件，CLI 帮助和 MCP schema 说明这项默认变化。
- 高层策略报价、preview 和新增订单准备使用同一产品策略；显式 marketId、旧链接式参数、缓存结果不得绕过默认部署的新业务限制。prepare 应复核准入。
- market_details、account_snapshot、还款、claim、撤单及已有资金退出保持可访问。只读订单历史也保留。不得用统一过滤后的目录代替 recovery 目录。
- 这是 Bivium 产品服务的准入策略，不声称关闭无许可 Core，也不声称其他直接链上客户端无法交易。

## 验收与停止条件

回归覆盖：

1. 两个方向参考价一致；源时间缺失、未来、过期边界、错误资产/链/Core、响应错误均拒绝，且没有旧接口回退。
2. 旧 profile Router 与新 Gate 不匹配时可选唯一兼容候选；多候选、读失败、错误 Core、无代码、费用/能力不合法均拒绝；未知费用的详情必须标 partial。
3. CASHCAT 任一腿的新业务拒绝，使用未来到期测试数据避免被到期判断掩盖；历史详情/仓位/还款/领取/撤单/退出不受下架影响。
4. mNVDA 正反市场均可发现；6/18 位精度、价格方向、fee-adjusted 成本边界和 prepare 复核覆盖齐全。
5. CLI、stdio MCP 和 HTTP MCP schema/序列化输出保持一致；已有测试、typecheck、Skill 同步检查及 Worker dry build 通过。
6. 只读在线 smoke 对照同一 Mock 快照与链上 Gate/费率。无钱包签名或链上交易；准备测试使用受控 fixtures 或模拟。

若发现需要改变合约、放宽风险政策、删除到期前 DCN 卖出保护、开放远程签名/订单写入或修改线上服务，停止并报告，不能并入此包。

## 自审

已区分参考价与成交价格、费率与本金比例、新业务与恢复查询、产品下架与协议权限、最新源码与线上 MCP 版本。设计无未决参数；待用户审阅后编写实施计划。
