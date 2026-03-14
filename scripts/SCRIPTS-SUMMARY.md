# PM2 管理脚本汇总

本目录包含用于管理 Codex Discord Bridge 服务的所有脚本。

## 脚本概览

| 脚本名 | 功能 | 用途 |
|--------|------|------|
| `pm2-commands.sh` | PM2 命令管理 | 主要管理工具，提供所有 PM2 命令快捷方式 |
| `quick-restart.sh` | 快速重启 | 快速重启服务，修复临时问题 |
| `dashboard.sh` | 监控仪表板 | 显示实时服务状态和健康信息 |
| `service-monitor.sh` | 服务监控 | 自动监控健康状态，自动重启不健康的服务 |
| `health-check.sh` | 健康检查 | 检查 HTTP 8788 端口健康状态 |

## 快速参考

### 日常使用

```bash
# 查看状态
./scripts/pm2-commands.sh status

# 查看日志
./scripts/pm2-commands.sh logs

# 快速重启
./scripts/quick-restart.sh

# 打开仪表板
./scripts/dashboard.sh
```

### 参考命令

```bash
# 健康检查
./scripts/pm2-commands.sh health
./scripts/health-check.sh

# 详细信息
./scripts/pm2-commands.sh info

# 清理日志
./scripts/pm2-commands.sh clean

# 保存状态
./scripts/pm2-commands.sh save
```

## 高级用法

### pm2-commands.sh 所有命令

```bash
./scripts/pm2-commands.sh status    # 显示服务状态
./scripts/pm2-commands.sh start     # 启动服务
./scripts/pm2-commands.sh stop      # 停止服务
./scripts/pm2-commands.sh restart   # 重启服务
./scripts/pm2-commands.sh logs      # 查看日志
./scripts/pm2-commands.sh info      # 详细信息
./scripts/pm2-commands.sh health    # 健康检查
./scripts/pm2-commands.sh clean     # 清理日志
./scripts/pm2-commands.sh save      # 保存状态
./scripts/pm2-commands.sh flush     # 清空日志
./scripts/pm2-commands.sh reset     # 重置重启计数
```

### 日志位置

- PM2 合并日志：`/tmp/codex-discord-bridge.pm2.log`
- PM2 错误日志：`/tmp/codex-discord-bridge.pm2.err.log`
- PM2 输出日志：`/tmp/codex-discord-bridge.pm2.out.log`
- 监控日志：`/tmp/codex-discord-bridge.monitor.log`

### 服务信息

- 服务名称：`codex-discord-bridge`
- HTTP 端口：8788
- 健康端点：`http://127.0.0.1:8788/healthz`
- PM2 配置：`ecosystem.config.cjs`

## 集成

### cron 任务

监控脚本已配置为每 5 分钟自动运行：

```bash
crontab -l | grep service-monitor
```

### PM2 命令

直接使用 PM2：

```bash
pm2 list
pm2 info codex-discord-bridge
pm2 logs codex-discord-bridge
pm2 restart codex-discord-bridge
```

## 文档

- 完整文档：`scripts/README.md`
- 部署文档：`DEPLOYMENT.md`
- PM2 配置：`ecosystem.config.cjs`
