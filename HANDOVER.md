# OpenClaw 项目交接文档 (HANDOVER)

## 一、 项目概览与目标 (Project Overview & Objectives)
OpenClaw 是一个基于 Node.js/Python 和 Polymarket 预测市场的自动化套利/预测交易扫描器。其目标是通过量化算法全自动运作，从识别高频流动性市场机会，一直到执行下单操作，并随着时间自动对信号准确度进行学习进化。

**核心交易逻辑管道分为四个阶段（M1 - M4）**：
1. **M1 (Signal generation)**：通过 Gamma API/CLOB API 捕捉实时赔率、Orderbook 深度失衡与过往价格的动量 (Momentum)，进而产出概率侧与置信度。
2. **M2 (Edge calculation)**：计算各维度的合并真实概率 `P_true`，计算期望值 Edge。如果盈亏比/边际大于 `netEdge > 0.02`（扣除 Maker/Taker 摩擦），进入执行层。
3. **M3 (Position sizing & Exec)**：Kelly (凯利公式) 根据资产净值决定建仓大小（针对小资金库还做了 25% 仓位低限兜底），并通过 Python `py_clob_client` 直接调用 Polymarket API 安全签名执行入局。
4. **M4 (Adapt engine)**：采用 Brier Score 算法。每一次离场结算都根据真实结果回调信号置信度。信号好久提权重，信号差就降权重（自适应性）。

---

## 二、 核心架构设计 (Core Architectural Details)

- **容器化执行环境**: 全部服务封装在一个 `docker-compose` 环境中 (`openclaw-scanner`)。核心为一个包含 Python3 (提供强一致性签名挂单功能) 与 Node.js 22 (高速并发市场监控逻辑) 的混合容器。
- **任务调度策略 (Crontab)**:
  - 核心交易扫描任务 (`market_scanner.mjs`) 每 **3** 分钟触发一次，受 `flock` 文件锁保护防并发踩踏。
  - 每日交易回顾推波任务 (`daily_report.mjs`) 于 **UTC 22:00 (北京时间早 6:00)** 触发，通过 ServerChan 微信接口推送每日盈亏和持仓异动情况。
- **数据源获取策略 (Data Fetching / Oracle)**:
  - 为了获得精确的 Volume 排名池，程序通过 `gamma-api.polymarket.com` 抓取市场，代码成功通过携带标准 `User-Agent` 的方式越过 Cloudflare 泛爬虫检测。
  - 区块链事实节点：通过内置 RPC 列表(`polygon-bor-rpc`等)和 ETH ABI (`0x00fdd58e` token balance / `0x70a08231` USDC total) 的底层方法验证资产持仓，不再依赖高延迟前端接口。
- **状态持久化方案 (Local Data Storage)**:
  - 所有重要资产持久化至 `./data` 目录下，并 Mount 回宿主机进行映射：
    - `trade_journal.json`: 负责 M4 评估的唯一真相交易日志流水。
    - `polymarket_positions.json`: 本地维护的开平仓记账单 (防止孤儿仓及防止单极方向反复补仓)。
    - `wallet.json` / `polymarket_api_key.json`: 密钥核心，通过 EIP-712 进行 Polygon L2 交易签名。

---

## 三、 当前文件结构与模块关系 (File Structure Diagram)

```text
c:\Users\kanun\openclaw\
├── docker-compose.yml         # 定义开机自启策略、/app 到 /data 目录的热更新直通挂载。
├── Dockerfile                 # 基于 node:22-slim 构建，整合安装了 crond 和 python3+pip。
├── entrypoint.sh              # 容器起点，负责挂载环境变量并载入 crontab。
├── crontab                    # 定义了高频扫描与每日早报推送的任务表。
├── HANDOVER.md                # 本交接状态文档
└── data/                      # 真实挂载区(持久状态) => 容器内的 /root/.openclaw & /app
    ├── market_scanner.mjs     # 核心组件，实现了 M1~M4 管道全流程业务逻辑。
    ├── daily_report.mjs       # [新增模块] 统计本地流水与链上钱包状态，构建日结报告并发至用户微信。
    ├── check_positions_onchain.mjs
    ├── final_check.mjs
    ├── place_order.py         # M3 依赖脚本，被 Node 调用进行严格的 L2 签名入账。
    ├── trade_journal.json     # 全部的交易审计历史日志
    ├── polymarket_positions.json # L2 持仓镜像
    └── signal_weights.json    # M4 引擎进化模型参数
```

---

## 四、 近期状态汇总与重大 Bug 修复记录 (Status & Fix Summary)
如果你是新接手的 Instance，请特别注意目前仓库已经进行了非常深入的极端边缘情况处理，切勿轻易回滚：
1. **代码同步问题根除**: 早期 `market_scanner` 部署为不同备份分发，现 Docker 中 `/app/market_scanner.mjs` 直接以只读形式映射于 `./data/market_scanner.mjs`，使得宿主机的编辑无缝生效以供 Cron 调用。
2. **"Volume=$100k" 假数据问题攻克**: 系统底层扫描器全面舍弃失效的 CLOB 极简市场接口，改换到 `Gamma API` 并附带了规避 CF 的请求头，如今系统的扫描会严谨**从真实现金流动性最高的池子**依次降序排查，避开了浅水池子风险。
3. **资金账户消失 Bug 修复**: 先前版本在遭遇 L2 Polygon 公共 RPC 闪断时，余额 API 返回空置，程序将其认为是持仓已清算（0 balance）进而引起掉链。现已更改为严格区分 `null`（请求错误）和 `0`（结算），不再出现持仓掉库问题。
4. **致命的 FATAL Timeout 防护**: 鉴于国内节点直连 Polygon/Polymarket 常发超时，在代码顶段植入了 5 分钟的 watchdog 断头台定时器和 `uncaughtException` 保底函数，超时即自尽交由底端系统 3 分钟后重启，解决无限阻塞死锁。
5. **小资金测试调优**: 凯利计算增加了针对较小账户的 `%` 托底算法。资金在 10-25U 区间内可以确保发出有效大小(`$5`)符合平台底线的真实交易单。
6. **早报发送功能激活**: 于 `daily_report.mjs` 集成了 ServerChan 接口与时区自适应 Cron，用户每日正常获取账户监控摘要。

**下一步行动建议 / 待办梳理 (Next Steps):**
- 现系统处于小全自动化盈利期，后续需重点审查 `trade_journal.json` 和 `signal_weights.json` 的耦合质量，以便确定 M4 算法引擎权重调度的可靠性。
- 对未被脚本 `polymarket_positions.json` 捕捉完全的历史“孤单”可以在之后有针对性清除或重整。
