# OpenClaw 项目现状与调试进度报告 (2026-03-30)

## 1. 项目基本信息
- **核心功能**：基于 Polymarket CLOB (限价订单簿) 的自动套利与趋势交易扫描器。
- **技术栈**：
  - `market_scanner.mjs` (Node.js/Viem): 负责市场扫描、信号计算 (Clob/Momentum) 及持仓评估。
  - `place_order.py` (Python/py_clob_client): 负责通过官方 SDK 执行具体的下单与卖出动作。
- **数据存储**：
  - `trade_journal.json`: 所有的信号、交易尝试及失败原因。
  - `polymarket_positions.json`: 本地记录的当前持仓状态。
  - `best_opportunities_history.jsonl`: 每一轮扫描产生的最佳机会历史记录。

## 2. 最近已完成的修复 (Fixes)
1. **下单参数归一化**：修复了将 `YES/NO` 错误传给 `side` 的 Bug，现在统一使用 `BUY/SELL`。
2. **浮点数截断 Bug**：修复了 JavaScript 在计算卖出 Token 数量时的精度问题（`Math.floor` -> `Math.round`），确保仓位能卖干净。
3. **认证授权修复 (401 Error)**：为所有敏感 API 请求添加了 HMAC 签名，消除了 `WARN 401` 报错。
4. **风控门槛放宽**：为了适应当前小额账户 ($5 左右)，将最低入场门槛从 $10 调低至 **$3**，并取消了单笔 50% 仓位的硬性限制。
5. **权限全面打通 (Allowance)**：手动通过脚本授权了 Polymarket 两个主流交易合约的 `setApprovalForAll` 权限，解决了无法卖出的问题。
6. **轻量化同步**：优化了持仓同步逻辑，默认仅检查已知 Token 余额，避免了大量 RPC 调用导致的卡顿。

## 3. 当前核心课题 (Current Issues)

### 课题 A：消失的 $1.31 与残余余额 $3.70
- **现状**：账户余额目前停留在 **$3.70**。
- **疑点**：之前的交易（Cason Wallace）在 14:24 左右清仓后，余额曾回升至 **$5.01**。随后发生了一次自动下单，产生了一笔 **1.68 份** 的成交，但我们手动取消了所有挂单后，这部分资金（约 $1.31）并未回到 USDC.e 余额中。
- **链上核实**：通过 `final_check.mjs` 确认，目前 `USDC.e` 余额确实只有 3.704，且 `Cason Wallace` 的 Token 持仓为 0。
- **下一步方向**：
  - 检查是否存在 **Native USDC**（Polygon 新版 USDC）。
  - 检查是否还有其他未被扫描到的 Token 占用了这 $1.31。
  - 确认是否存在 Polymarket 平台的“结算延迟”或“已锁定资金”。

### 课题 B：新机会的自动入场
- **现状**：扫描器虽然在运行并记录 `Best opportunity`，但由于上述余额问题，入场可能受限。
- **要求**：在找回资金的同时，确保一旦信号达成一致，扫描器能第一时间以当前的 $3.70+ 余额全仓杀入。

## 4. 关键调试工具
- `docker exec openclaw-scanner node /root/.openclaw/final_check.mjs`: 查链上真实现金和特定 Token 余额。
- `docker exec openclaw-scanner python3 /root/.openclaw/verify_fill_fees.py`: 查 API 真实成交历史和手续费。
- `docker exec openclaw-scanner python3 /root/.openclaw/cleanup_all.py`: 一键取消所有挂单并释放资金。
