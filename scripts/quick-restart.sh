#!/bin/bash

# Codex Discord Bridge - 快速重启脚本
# 用于快速重启服务，通常用于修复临时问题

echo "================================"
echo "Codex Discord Bridge 快速重启"
echo "================================"
echo ""

# 停止服务（如果运行中）
echo "步骤 1/3: 停止服务 ..."
pm2 stop codex-discord-bridge 2>/dev/null

# 清理端口
echo "步骤 2/3: 清理端口 ..."
pkill -9 -f "codex.*app-server" 2>/dev/null
sleep 2

# 启动服务
echo "步骤 3/3: 启动服务 ..."
cd /Users/aias/.openclaw/ai-bot-gateway
pm2 start ecosystem.config.cjs

sleep 3

# 检查状态
echo ""
echo "================================"
echo "服务状态"
echo "================================"
pm2 list

echo ""
echo "================================"
echo "健康检查"
echo "================================"
if curl -s http://127.0.0.1:8788/healthz | grep -q '"ok":true'; then
    echo "✓ 服务健康"
else
    echo "✗ 服务可能未正常启动"
fi

echo ""
echo "✅ 服务重启完成"