# Codex Discord Bridge - PM2 管理脚本

这是一个 PM2 进程管理的命令行工具集合，用于管理 Codex Discord Bridge 服务。

## 脚本列表

### 1. pm2-commands.sh - PM2 命令管理

主要的管理脚本，提供各种 PM2 命令的快捷方式。

```bash
cd ~/.openclaw/ai-bot-gateway
./scripts/pm2-commands.sh [命令]
```

#### 可用命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `status` | 显示服务状态 | `./scripts/pm2-commands.sh status` |
| `start` | 启动服务 | `./scripts/pm2-commands.sh start` |
| `stop` | 停止服务 | `./scripts/pm2-commands.sh stop` |
| `restart` | 重启服务 | `./scripts/pm2-commands.sh restart` |
| `logs` | 查看日志 | `./scripts/pm2-commands.sh logs 100` |
| `info` | 显示服务详细信息 | `./scripts/pm2-commands.sh info` |
| `health` | 检查服务健康 | `./scripts/pm2-commands.sh health` |
| `clean` | 清理 PM2 日志 | `./scripts/pm2-commands.sh clean` |
| `save` | 保存 PM2 状态 | `./scripts/pm2-commands.sh save` |
| `flush` | 清空日志 | `./scripts/pm2-commands.sh flush` |
| `reset` | 重置重启计数 | `./scripts/pm2-commands.sh reset` |

### 2. quick-restart.sh - 快速重启

快速重启服务，用于修复临时问题。

```bash
cd ~/.openclaw/ai-bot-gateway
./scripts/quick-restart.sh
```

**执行步骤：**
1. 停止服务
2. 清理端口
3. 启动服务
4. 验证服务状态

### 3. dashboard.sh - 监控仪表板

显示服务的实时状态和关键信息。

```bash
cd ~/.openclaw/ai-bot-gateway
./scripts/dashboard.sh
```

**显示内容：**
- 当前时间
- PM2 服务状态
- HTTP 健康检查
- 最近错误日志
- 监控日志
- 快捷命令参考

### 4. service-monitor.sh - 服务监控

自动监控服务健康状态，自动重启不健康的服务。已配置为 cron 任务，每 5 分钟运行一次。

```bash
cd ~/.openclaw/ai-bot-gateway
./scripts/service-monitor.sh
```

## 快速开始

### 查看服务状态

```bash
./scripts/pm2-commands.sh status
```

### 查看日志

```bash
# 查看最近 100 行日志
./scripts/pm2-commands.sh logs 100

# 查看最近 500 行日志
./scripts/pm2-commands.sh logs 500
```

### 重启服务

```bash
# 如果知道服务有问题，使用快速重启
./scripts/quick-restart.sh

# 或者使用 PM2 命令
./scripts/pm2-commands.sh restart
```

### 检查服务健康

```bash
./scripts/pm2-commands.sh health
```

### 打开监控面板

```bash
# 使用仪表板脚本（推荐）
./scripts/dashboard.sh

# 或使用 PM2 原生监控
pm2 monit
```

## 常见问题排查

### 服务崩溃了怎么办？

```bash
# 方法 1: 使用快速重启
./scripts/quick-restart.sh

# 方法 2: 使用 PM2 重启
./scripts/pm2-commands.sh restart

# 方法 3: 查看错误日志
./scripts/pm2-commands.sh logs
tail -50 /tmp/codex-discord-bridge.pm2.err.log
```

### 服务健康检查失败

```bash
# 检查健康
./scripts/pm2-commands.sh health

# 查看监控日志
tail -20 /tmp/codex-discord-bridge.monitor.log

# 手动执行监控脚本
cd ~/.openclaw/ai-bot-gateway
./scripts/service-monitor.sh
```

### 查看详细的服务信息

```bash
./scripts/pm2-commands.sh info
pm2 info codex-discord-bridge
```

## 日志文件位置

| 日志类型 | 文件路径 | 说明 |
|---------|---------|------|
| PM2 合并日志 | `/tmp/codex-discord-bridge.pm2.log` | 所有日志合并 |
| PM2 错误日志 | `/tmp/codex-discord-bridge.pm2.err.log` | 仅错误 |
| PM2 输出日志 | `/tmp/codex-discord-bridge.pm2.out.log` | 仅输出 |
| 监控日志 | `/tmp/codex-discord-bridge.monitor.log` | 健康监控记录 |

## PM2 原生命令

如果你更喜欢直接使用 PM2 命令：

```bash
# 查看所有进程
pm2 list

# 查看信息
pm2 info codex-discord-bridge

# 查看日志
pm2 logs codex-discord-bridge

# 重启
pm2 restart codex-discord-bridge

# 停止
pm2 stop codex-discord-bridge

# 删除
pm2 delete codex-discord-bridge

# 保存状态
pm2 save

# 监控面板
pm2 monit
```

## 权限设置

所有脚本都已添加执行权限。如果遇到权限问题：

```bash
chmod +x ~/.openclaw/ai-bot-gateway/scripts/*.sh
```

## 系统集成

### Cron 任务（定时监控）

监控脚本已配置为 cron 任务，每 5 分钟运行一次：

```bash
# 查看当前 crontab
crontab -l

# 手动添加（如果未配置）
(crontab -l; echo "*/5 * * * * /Users/aias/.openclaw/ai-bot-gateway/scripts/service-monitor.sh") | crontab -
```

### 开机自启

服务已配置为开机自启，但需要手动执行以下命令：

```bash
sudo env PATH=$PATH:/Users/aias/.nvm/versions/node/v22.22.0/bin /Users/aias/.nvm/versions/node/v22.22.0/lib/node_modules/pm2/bin/pm2 startup launchd -u a1234 --hp /Users/aias
```

## 高级用法

### 零停机重启

```bash
./scripts/pm2-commands.sh reload
```

### 重置重启计数

```bash
./scripts/pm2-commands.sh reset
```

### 清空所有日志

```bash
./scripts/pm2-commands.sh clean
```

## 帮助

查看脚本帮助：

```bash
./scripts/pm2-commands.sh
```

## 故障排除

如果命令无法执行：

1. 检查脚本路径是否正确
2. 确认有执行权限
3. 检查 Node.js 和 npm 是否正确安装
4. 查看 PM2 日志定位问题

## 更新日志

- **2026-03-14**: 初始版本
  - 创建 PM2 管理脚本
  - 添加快速重启脚本
  - 添加监控仪表板
  - 配置定时服务监控