#!/bin/bash

# Codex Discord Bridge - 日志分析工具
# 深度分析 PM2 日志，提取关键信息

LOG_BASE="/tmp/codex-discord-bridge"
OUT_LOG="$LOG_BASE.pm2.out.log"
ERR_LOG="$LOG_BASE.pm2.err.log"
MONITOR_LOG="/tmp/codex-discord-bridge.monitor.log"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

show_header() {
    echo -e "${BLUE}========================================${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}========================================${NC}"
}

analyze_startup_sequence() {
    show_header "启动序列分析"
    
    echo "最近一次启动日志:"
    if [ -f "$OUT_LOG" ]; then
        grep -E "listening on|connected|ready|bootstrap" "$OUT_LOG" | tail -10
    fi
    
    echo ""
    echo "启动持续时间:"
    if [ -f "$OUT_LOG" ]; then
        local first_line=$(grep -n "listening on" "$OUT_LOG" | tail -1 | cut -d':' -f1)
        local last_line=$(grep -n "channel bootstrap complete" "$OUT_LOG" | tail -1 | cut -d':' -f1)
        
        if [[ -n $first_line && -n $last_line ]]; then
            echo "启动完成 (从开始到就绪)"
        fi
    fi
}

analyze_error_patterns() {
    show_header "错误模式分析"
    
    if [ ! -f "$ERR_LOG" ]; then
        echo "错误日志文件不存在"
        return
    fi
    
    echo "错误类型统计 (最近 500 行):"
    tail -500 "$ERR_LOG" | grep -E "ERROR|Error|error" | \
        grep -oE "E[A-Z]+|Segmentation fault|RangeError|TypeError|ReferenceError" | \
        sort | uniq -c | sort -rn
    
    echo ""
    echo "Codex 错误统计:"
    tail -500 "$ERR_LOG" | grep "codex.*ERROR" | \
        grep -oE "codex_core::[a-z_]+" | sort | uniq -c | sort -rn | head -10
    
    echo ""
    echo "最近 10 个错误:"
    tail -500 "$ERR_LOG" | grep -E "ERROR|Error" | tail -10
}

analyze_error_frequency() {
    show_header "错误频率分析"
    
    if [ ! -f "$ERR_LOG" ]; then
        echo "错误日志文件不存在"
        return
    fi
    
    echo "最近 1 小时错误:"
    local one_hour_ago=$(date -v-1H '+%b %d %H:%M')
    echo "$one_hour_ago 之后的错误:"
    grep -E "ERROR" "$ERR_LOG" | grep -A 0 "$one_hour_ago" | wc -l
    
    echo ""
    echo "错误时间分布 (按小时):"
    grep "ERROR" "$ERR_LOG" | grep -oE "Mar [0-9]+ [0-9]+" | sort | uniq -c
    
    echo ""
    echo "错误密集时段:"
    grep "ERROR" "$ERR_LOG" | grep -oE "Mar [0-9]+ [0-9]+" | sort | uniq -c | sort -rn | head -5
}

analyze_connection_issues() {
    show_header "连接问题分析"
    
    if [ ! -f "$ERR_LOG" ]; then
        echo "错误日志文件不存在"
        return
    fi
    
    echo "连接错误统计:"
    echo "  EADDRINUSE (端口占用): $(grep -c 'EADDRINUSE' "$ERR_LOG" 2>/dev/null || echo 0)"
    echo "  连接拒绝: $(grep -c 'refused to connect\|Connection refused' "$ERR_LOG" 2>/dev/null || echo 0)"
    echo "  超时: $(grep -c 'timeout\|Timeout' "$ERR_LOG" 2>/dev/null || echo 0)"
    echo "  连接断开: $(grep -c 'disconnected\|Connection lost' "$ERR_LOG" 2>/dev/null || echo 0)"
    
    echo ""
    echo "最近连接问题:"
    grep -E "EADDRINUSE|refused|timeout|disconnected" "$ERR_LOG" | tail -10
}

analyze_resource_usage() {
    show_header "资源使用分析"
    
    # PM2 内存使用
    pm2 info codex-discord-bridge 2>/dev/null | grep -E "mem size|heap size|CPU usage" | head -10
    
    echo ""
    echo "内存增长检测:"
    local mem_values=$(pm2 list 2>/dev/null | grep codex-discord-bridge | awk '{print $11}')
    if [[ -n $mem_values ]] && [[ $(echo "$mem_values" | wc -w) -gt 1 ]]; then
        echo "最近几次内存检查: $mem_values"
    fi
}

analyze_service_availability() {
    show_header "服务可用性分析"
    
    if [ -f "$MONITOR_LOG" ]; then
        echo "监控日志统计 (最近 100 行):"
        tail -100 "$MONITOR_LOG" | grep -oE "passed|failed|OK|ERROR" | sort | uniq -c
        
        echo ""
        echo "最近监控记录:"
        tail -10 "$MONITOR_LOG"
    fi
    
    # PM2 重启统计
    pm2 list 2>/dev/null | grep codex-discord-bridge | awk '{printf "重启次数: %s\n运行时长: %s\n", $9, $8}'
}

analyze_performance_trends() {
    show_header "性能趋势"
    
    # 调用性能监控脚本
    if [ -f "/Users/aias/.openclaw/ai-bot-gateway/scripts/performance-monitor.sh" ]; then
        bash /Users/aias/.openclaw/ai-bot-gateway/scripts/performance-monitor.sh analyze
    else
        echo "性能监控脚本未找到"
    fi
}

generate_summary() {
    show_header "分析总结"
    
    local total_errors=0
    if [ -f "$ERR_LOG" ]; then
        total_errors=$(grep -c "ERROR" "$ERR_LOG" 2>/dev/null || echo 0)
    fi
    
    local pm2_status=$(pm2 list 2>/dev/null | grep codex-discord-bridge | awk '{print $10}')
    local http_health="未知"
    
    if curl -s http://127.0.0.1:8788/healthz | grep -q '"ok":true'; then
        http_health="正常"
    else
        http_health="异常"
    fi
    
    echo "PM2 状态: $pm2_status"
    echo "HTTP 健康检查: $http_health"
    echo "错误总数 (日志): $total_errors"
    
    echo ""
    echo "建议:"
    
    if [[ $total_errors -gt 10 ]]; then
        echo -e "${YELLOW}⚠️ 错误数量较多，建议查看详细错误日志${NC}"
    fi
    
    if [[ $pm2_status != "online" ]]; then
        echo -e "${RED}✗ 服务状态异常，请尝试重启${NC}"
    fi
    
    if [[ $http_health == "异常" ]]; then
        echo -e "${RED}✗ HTTP API 异常，请检查端口和服务状态${NC}"
    fi
}

# 主函数
main() {
    local analysis_type="${1:-all}"
    
    clear
    echo -e "${BLUE}═════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}     Codex Discord Bridge - 日志分析工具${NC}"
    echo -e "${BLUE}═════════════════════════════════════════════════════${NC}"
    echo ""
    
    case $analysis_type in
        startup)
            analyze_startup_sequence
            ;;
        errors)
            analyze_error_patterns
            analyze_error_frequency
            analyze_connection_issues
            ;;
        resources)
            analyze_resource_usage
            ;;
        availability)
            analyze_service_availability
            ;;
        performance)
            analyze_performance_trends
            ;;
        summary)
            generate_summary
            ;;
        all)
            analyze_startup_sequence
            echo ""
            analyze_error_patterns
            echo ""
            analyze_error_frequency
            echo ""
            analyze_connection_issues
            echo ""
            analyze_resource_usage
            echo ""
            analyze_service_availability
            echo ""
            generate_summary
            ;;
        *)
            echo "用法: $0 [分析类型]"
            echo ""
            echo "分析类型:"
            echo "  startup      - 启动序列分析"
            echo "  errors       - 错误分析 (模式+频率+连接)"
            echo "  resources    - 资源使用分析"
            echo "  availability - 服务可用性分析"
            echo "  performance  - 性能趋势分析"
            echo "  summary      - 分析总结"
            echo "  all          - 完整分析 (默认)"
            ;;
    esac
    
    echo ""
}

main "$@"