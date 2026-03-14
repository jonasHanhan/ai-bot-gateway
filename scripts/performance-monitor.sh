#!/bin/bash

# Codex Discord Bridge - 性能监控
# 定期采集性能指标，用于趋势分析和容量规划

OUTPUT_DIR="/Users/aias/.openclaw/ai-bot-gateway/logs/perf"
mkdir -p "$OUTPUT_DIR"

CSV_FILE="$OUTPUT_DIR/metrics_$(date '+%Y%m%d').csv"

# 初始化 CSV 文件（如果不存在）
if [ ! -f "$CSV_FILE" ]; then
    echo "timestamp,pid,cpu_percent,memory_mb,active_turns,pending_approvals,http_health" > "$CSV_FILE"
fi

collect_metrics() {
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    
    # 获取进程信息
    local pm2_line=$(pm2 list 2>/dev/null | grep "codex-discord-bridge" | tr '│' ' ')
    local pid=$(echo "$pm2_line" | awk '{print $6}')
    local cpu=$(echo "$pm2_line" | awk '{print $10}' | tr -d '%')
    local mem=$(echo "$pm2_line" | awk '{print $11}' | tr -d 'mb')
    
    # 默认值
    if [[ -z $pid ]]; then pid="N/A"; fi
    if [[ -z $cpu ]]; then cpu="0"; fi
    if [[ -z $mem ]]; then mem="0"; fi
    
    # 服务健康指标
    local health_response=$(curl -s http://127.0.0.1:8788/healthz 2>/dev/null)
    local active_turns=$(echo "$health_response" | grep -o '"activeTurns":[0-9]*' | cut -d':' -f2 || echo "0")
    local pending=$(echo "$health_response" | grep -o '"pendingApprovals":[0-9]*' | cut -d':' -f2 || echo "0")
    local http_health="0"
    
    if [[ $health_response == *"ok":true* ]] || [[ $health_response == *"\"ok\":true"* ]]; then
        http_health="1"
    fi
    
    # 修复 CPU 解析（如果包含额外字段）
    if [[ $cpu == *"%"* ]]; then
        cpu=$(echo "$cpu" | awk '{if ($1 ~ /[0-9]+%/ && $2 ~ /[0-9]+/) {print $1} else print $0}')
    fi
    
    # 输出 CSV
    echo "$timestamp,$pid,$cpu,$mem,$active_turns,$pending,$http_health" >> "$CSV_FILE"
    
    # 输出到控制台
    local health_status="✓"
    if [[ $http_health == "0" ]]; then
        health_status="✗"
    fi
    
    printf "[%s] PID: %-8s CPU: %-6s%% Mem: %-8s Turns: %-4s Health: %s\n" \
        "$timestamp" "$pid" "$cpu" "${mem}MB" "$active_turns" "$health_status"
}

# 分析性能趋势
analyze_trends() {
    local csv_file="$CSV_FILE"
    
    if [ ! -f "$csv_file" ] || [ $(wc -l < "$csv_file") -lt 10 ]; then
        echo "数据不足，无法分析趋势"
        return
    fi
    
    echo ""
    echo "========================================"
    echo "性能趋势分析 (最近 100 条数据)"
    echo "========================================"
    
    # 计算平均值
    local avg_cpu=$(tail -100 "$csv_file" | cut -d',' -f3 | awk '{sum+=$1} END {print sum/NR}')
    local avg_mem=$(tail -100 "$csv_file" | cut -d',' -f4 | awk '{sum+=$1} END {print sum/NR}')
    local avg_turns=$(tail -100 "$csv_file" | cut -d',' -f5 | awk '{sum+=$1} END {print sum/NR}')
    local health_issues=$(tail -100 "$csv_file" | cut -d',' -f7 | awk '{if($1=="0") count++} END {print count}')
    
    echo "平均 CPU 使用: ${avg_cpu}%"
    echo "平均内存使用: ${avg_mem}MB"
    echo "平均活跃对话: ${avg_turns}"
    echo "健康检查失败: ${health_issues} 次"
    
    # 检测异常
    echo ""
    echo "异常检测:"
    
    # CPU 过高
    if (( $(echo "$avg_cpu > 80" | bc -l) )); then
        echo "⚠️ CPU 使用率过高 (>80%)"
    fi
    
    # 内存过高
    if (( $(echo "$avg_mem > 500" | bc -l) )); then
        echo "⚠️ 内存使用过高 (>500MB)"
    fi
    
    # 健康检查失败
    if [[ $health_issues -gt 0 ]]; then
        echo "⚠️ 健康检查失败次数: $health_issues"
    fi
}

# 主函数
main() {
    local mode="${1:-collect}"
    
    case $mode in
        collect)
            collect_metrics
            ;;
        analyze)
            analyze_trends
            ;;
        full)
            collect_metrics
            analyze_trends
            ;;
        *)
            echo "用法: $0 [collect|analyze|full]"
            echo "  collect  - 采集当前性能指标"
            echo "  analyze  - 分析性能趋势"
            echo "  full     - 采集并分析"
            exit 1
            ;;
    esac
}

main "$@"