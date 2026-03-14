#!/bin/bash

# Codex Discord Bridge - 监控仪表板
# 显示服务当前状态和健康信息

# 颜色定义
BLUE='\033[0;34m'
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

clear

echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}     Codex Discord Bridge - 监控仪表板${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
echo ""

# 获取时间
echo "📅 $(date '+%Y-%m-%d %H:%M:%S')"
echo ""

# PM2 服务状态
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}🔄 PM2 服务状态${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
pm2 list 2>/dev/null | grep "codex-discord-bridge" || echo "❌ 服务未找到"
echo ""

# 服务健康检查
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}🏥 健康检查 (HTTP:8788)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
HEALTH_RESPONSE=$(curl -s http://127.0.0.1:8788/healthz 2>&1)
if [[ $HEALTH_RESPONSE == *"ok":true* ]]; then
    echo -e "${GREEN}✓ 服务状态: OK${NC}"
    echo -e "${GREEN}✓ 就绪状态: READY${NC}"
    ACTIVE_TURNS=$(echo "$HEALTH_RESPONSE" | grep -o '"activeTurns":[0-9]*' | cut -d':' -f2)
    PENDING=$(echo "$HEALTH_RESPONSE" | grep -o '"pendingApprovals":[0-9]*' | cut -d':' -f2)
    CHANNELS=$(echo "$HEALTH_RESPONSE" | grep -o '"mappedChannels":[0-9]*' | cut -d':' -f2)
    echo "  活跃对话: $ACTIVE_TURNS"
    echo "  待审批: $PENDING"
    echo "  映射频道: $CHANNELS"
else
    echo -e "${RED}✗ 服务不健康或无法访问${NC}"
fi
echo ""

# 最近日志
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📝 最近错误日志 (最后 5 行)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ -f "/tmp/codex-discord-bridge.pm2.err.log" ]; then
    tail -5 /tmp/codex-discord-bridge.pm2.err.log | grep -i "error\|fail" | head -5 || echo "✓ 无错误日志"
else
    echo "日志文件不存在"
fi
echo ""

# 监控日志
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}📊 监控日志 (最后 3 条)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
if [ -f "/tmp/codex-discord-bridge.monitor.log" ]; then
    tail -3 /tmp/codex-discord-bridge.monitor.log
else
    echo "监控日志不存在"
fi
echo ""

# 快捷命令
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}⚡ 快捷命令${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo "  pm2-commands.sh status  - 查看完整状态"
echo "  pm2-commands.sh logs    - 查看日志"
echo "  pm2-commands.sh restart - 重启服务"
echo "  pm2-commands.sh health  - 健康检查"
echo "  quick-restart.sh        - 快速重启"
echo ""

echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"
echo -e "${CYAN}按 Ctrl+C 退出 | 按 Enter 刷新${NC}"
echo -e "${CYAN}═══════════════════════════════════════════════════════${NC}"

# 等待用户输入以刷新
read -t 30 -n 1

# 递归调用以实现自动刷新
if [ $? -eq 0 ] && [ "$REPLY" = "" ]; then
    exec $0
fi