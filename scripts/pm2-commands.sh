#!/bin/bash

# Codex Discord Bridge - PM2 管理脚本
# 提供常用的 PM2 命令快捷方式

APP_NAME="codex-discord-bridge"
PM2_PATH="/Users/aias/.nvm/versions/node/v22.22.0/bin/pm2"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_header() {
    echo -e "${BLUE}================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}================================${NC}"
}

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

# 显示帮助信息
show_help() {
    echo "Codex Discord Bridge - PM2 管理脚本"
    echo ""
    echo "用法: ./pm2-commands.sh [命令] [选项]"
    echo ""
    echo "命令:"
    echo "    status       - 显示服务状态"
    echo "    start        - 启动服务"
    echo "    stop         - 停止服务"
    echo "    restart      - 重启服务"
    echo "    logs         - 查看日志"
    echo "    info         - 显示服务详细信息"
    echo "    health       - 检查服务健康状态"
    echo "    clean        - 清理 PM2 日志"
    echo "    save         - 保存 PM2 进程列表"
    echo "    flush        - 清空日志"
    echo "    reset        - 重置重启计数"
    echo ""
    echo "示例:"
    echo "    ./pm2-commands.sh status"
    echo "    ./pm2-commands.sh logs 100"
    echo ""
}

# 显示服务状态
cmd_status() {
    print_header "服务状态"
    $PM2_PATH list
}

# 启动服务
cmd_start() {
    print_header "启动服务"
    cd /Users/aias/.openclaw/ai-bot-gateway
    $PM2_PATH start ecosystem.config.cjs
    sleep 3
    if $PM2_PATH list | grep -q "$APP_NAME.*online"; then
        print_success "服务启动成功"
        $PM2_PATH list
    else
        print_error "服务启动失败"
    fi
}

# 停止服务
cmd_stop() {
    print_header "停止服务"
    $PM2_PATH stop $APP_NAME
    sleep 2
    print_success "服务已停止"
    $PM2_PATH list
}

# 重启服务
cmd_restart() {
    print_header "重启服务"
    $PM2_PATH restart $APP_NAME
    sleep 3
    if $PM2_PATH list | grep -q "$APP_NAME.*online"; then
        print_success "服务重启成功"
        $PM2_PATH list
    else
        print_error "服务重启失败"
    fi
}

# 查看日志
cmd_logs() {
    local lines="${1:-100}"
    print_header "查看日志 (最近 $lines 行)"
    $PM2_PATH logs $APP_NAME --lines $lines --nostream
}

# 显示服务信息
cmd_info() {
    print_header "服务详细信息"
    $PM2_PATH info $APP_NAME
}

# 检查服务健康
cmd_health() {
    print_header "服务健康检查"
    local response=$(curl -s http://127.0.0.1:8788/healthz 2>&1)
    if [[ $response == *"ok":true* ]] || [[ $response == *"\"ok\":true"* ]]; then
        print_success "服务健康"
        echo "$response" | python3 -m json.tool 2>/dev/null || echo "$response"
    else
        print_error "服务不健康"
        echo "响应: $response"
    fi
}

# 清理 PM2 日志
cmd_clean() {
    print_header "清理 PM2 日志"
    $PM2_PATH flush
    print_success "日志已清理"
}

# 保存 PM2 进程列表
cmd_save() {
    print_header "保存 PM2 进程列表"
    $PM2_PATH save
    print_success "PM2 状态已保存"
}

# 清空日志
cmd_flush() {
    print_header "清空日志"
    $PM2_PATH flush
    print_success "日志已清空"
}

# 重置重启计数
cmd_reset() {
    print_header "重置重启计数"
    $PM2_PATH reset $APP_NAME
    print_success "重启计数已重置"
    echo ""
    $PM2_PATH list
}

# 主逻辑
case "${1:-}" in
    status)
        cmd_status
        ;;
    start)
        cmd_start
        ;;
    stop)
        cmd_stop
        ;;
    restart)
        cmd_restart
        ;;
    logs)
        cmd_logs "${2:-100}"
        ;;
    info)
        cmd_info
        ;;
    health)
        cmd_health
        ;;
    clean)
        cmd_clean
        ;;
    save)
        cmd_save
        ;;
    flush)
        cmd_flush
        ;;
    reset)
        cmd_reset
        ;;
    *)
        show_help
        ;;
esac