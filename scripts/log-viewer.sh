#!/bin/bash

# Codex Discord Bridge - 日志查看工具
# 提供多种日志查看和过滤方式

LOG_BASE="/tmp/codex-discord-bridge"
PM2_OUT="$LOG_BASE.pm2.out.log"
PM2_ERR="$LOG_BASE.pm2.err.log"
MONITOR="/tmp/codex-discord-bridge.monitor.log"
EVENTS="/tmp/codex-discord-bridge.events.log.txt"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

show_menu() {
    clear
    echo -e "${BLUE}═════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  Codex Discord Bridge - 日志查看工具${NC}"
    echo -e "${BLUE}═════════════════════════════════════════════════════${NC}"
    echo ""
    echo "[1] 查看最新输出日志 (PM2)"
    echo "[2] 查看最新错误日志 (PM2)"
    echo "[3] 查看监控日志"
    echo "[4] 查看事件日志"
    echo "[5] 查看特定类型的日志"
    echo "[6] 实时跟踪日志"
    echo "[7] 搜素日志内容"
    echo "[8] 日志统计"
    echo "[0] 退出"
    echo ""
    echo -n "请选择: "
}

view_latest_output() {
    clear
    echo -e "${BLUE}最新输出日志 (最后 50 行)${NC}"
    echo "========================================"
    if [ -f "$PM2_OUT" ]; then
        tail -50 "$PM2_OUT"
    else
        echo "日志文件不存在: $PM2_OUT"
    fi
}

view_latest_errors() {
    clear
    echo -e "${RED}最新错误日志 (最后 50 行)${NC}"
    echo "========================================"
    if [ -f "$PM2_ERR" ]; then
        tail -50 "$PM2_ERR"
    else
        echo "日志文件不存在: $PM2_ERR"
    fi
}

view_monitor_log() {
    clear
    echo -e "${BLUE}监控日志 (最后 30 行)${NC}"
    echo "========================================"
    if [ -f "$MONITOR" ]; then
        tail -30 "$MONITOR"
    else
        echo "日志文件不存在: $MONITOR"
    fi
}

view_events_log() {
    clear
    echo -e "${YELLOW}事件日志 (最后 50 行)${NC}"
    echo "========================================"
    if [ -f "$EVENTS" ]; then
        tail -50 "$EVENTS"
    else
        echo "日志文件不存在: $EVENTS"
    fi
}

view_specific_logs() {
    clear
    echo "选择要查看的日志类型:"
    echo "========================================"
    echo "[1] 启动相关日志"
    echo "[2] 连接相关日志"
    echo "[3] 错误日志 (仅错误)"
    echo "[4] 健康检查日志"
    echo "[0] 返回"
    echo ""
    read -p "请选择: " choice
    
    case $choice in
        1)
            clear
            echo -e "${GREEN}启动相关日志${NC}"
            echo "========================================"
            if [ -f "$PM2_OUT" ]; then
                grep -E "listening|connected|ready|bootstrap" "$PM2_OUT" | tail -30
            fi
            ;;
        2)
            clear
            echo -e "${YELLOW}连接相关日志${NC}"
            echo "========================================"
            echo "输出日志:"
            if [ -f "$PM2_OUT" ]; then
                grep -E "Discord connected|feishu transport ready" "$PM2_OUT" | tail -20
            fi
            echo ""
            echo "错误日志:"
            if [ -f "$PM2_ERR" ]; then
                grep -E "refused|timeout|disconnected" "$PM2_ERR" | tail -20
            fi
            ;;
        3)
            clear
            echo -e "${RED}错误日志${NC}"
            echo "========================================"
            if [ -f "$PM2_ERR" ]; then
                grep -E "ERROR|Error" "$PM2_ERR" | tail -30
            fi
            ;;
        4)
            clear
            echo -e "${GREEN}健康检查日志${NC}"
            echo "========================================"
            if [ -f "$MONITOR" ]; then
                tail -20 "$MONITOR"
            fi
            ;;
        0)
            return
            ;;
    esac
    
    read -p "按回车键继续..."
}

tail_logs() {
    clear
    echo "选择要跟踪的日志:"
    echo "========================================"
    echo "[1] 输出日志 (PM2)"
    echo "[2] 错误日志 (PM2)"
    echo "[3] 监控日志"
    echo "[0] 返回"
    echo ""
    read -p "请选择: " choice
    
    case $choice in
        1)
            clear
            echo -e "${BLUE}实时跟踪: 输出日志${NC}"
            echo "按 Ctrl+C 停止"
            echo "========================================"
            tail -f "$PM2_OUT"
            ;;
        2)
            clear
            echo -e "${RED}实时跟踪: 错误日志${NC}"
            echo "按 Ctrl+C 停止"
            echo "========================================"
            tail -f "$PM2_ERR"
            ;;
        3)
            clear
            echo -e "${GREEN}实时跟踪: 监控日志${NC}"
            echo "按 Ctrl+C 停止"
            echo "========================================"
            tail -f "$MONITOR"
            ;;
        0)
            return
            ;;
    esac
}

search_logs() {
    read -p "输入搜索内容: " search_term
    
    if [[ -z $search_term ]]; then
        return
    fi
    
    clear
    echo -e "${BLUE}搜索结果: '$search_term'${NC}"
    echo "========================================"
    
    echo "输出日志:"
    if [ -f "$PM2_OUT" ]; then
        grep -n --color=always "$search_term" "$PM2_OUT" | head -20
    fi
    
    echo ""
    echo "错误日志:"
    if [ -f "$PM2_ERR" ]; then
        grep -n --color=always "$search_term" "$PM2_ERR" | head -20
    fi
    
    echo ""
    read -p "按回车键继续..."
}

show_stats() {
    clear
    echo -e "${BLUE}日志统计${NC}"
    echo "========================================"
    
    # PM2 输出日志统计
    if [ -f "$PM2_OUT" ]; then
        echo "输出日志:"
        echo "  总行数: $(wc -l < "$PM2_OUT")"
        echo "  最后更新: $(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$PM2_OUT")"
    fi
    
    # PM2 错误日志统计
    if [ -f "$PM2_ERR" ]; then
        echo ""
        echo "错误日志:"
        echo "  总行数: $(wc -l < "$PM2_ERR")"
        echo "  错误数: $(grep -c "ERROR" "$PM2_ERR" 2>/dev/null || echo 0)"
        echo "  最后更新: $(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$PM2_ERR")"
    fi
    
    # 监控日志统计
    if [ -f "$MONITOR" ]; then
        echo ""
        echo "监控日志:"
        echo "  检查通过: $(grep -c "passed" "$MONITOR" 2>/dev/null || echo 0)"
        echo "  检查失败: $(grep -c "failed" "$MONITOR" 2>/dev/null || echo 0)"
        echo "  最后更新: $(stat -f "%Sm" -t "%Y-%m-%d %H:%M:%S" "$MONITOR")"
    fi
    
    echo ""
    read -p "按回车键继续..."
}

# 主循环
main() {
    while true; do
        show_menu
        read choice
        
        case $choice in
            1)
                view_latest_output
                read -p "按回车键继续..."
                ;;
            2)
                view_latest_errors
                read -p "按回车键继续..."
                ;;
            3)
                view_monitor_log
                read -p "按回车键继续..."
                ;;
            4)
                view_events_log
                read -p "按回车键继续..."
                ;;
            5)
                view_specific_logs
                ;;
            6)
                tail_logs
                ;;
            7)
                search_logs
                ;;
            8)
                show_stats
                ;;
            0)
                echo "退出..."
                exit 0
                ;;
            *)
                echo "无效选择"
                sleep 1
                ;;
        esac
    done
}

main