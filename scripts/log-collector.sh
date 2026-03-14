#!/bin/bash

# Codex Discord Bridge - 日志聚合工具
# 收集、分析和汇总服务日志，用于问题追踪

# 配置
LOG_DIR="/tmp"
SERVICE_NAME="codex-discord-bridge"
OUTPUT_DIR="/Users/aias/.openclaw/ai-bot-gateway/logs"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

# 创建输出目录
mkdir -p "$OUTPUT_DIR"

# 时间戳
TIMESTAMP=$(date '+%Y%m%d_%H%M%S')

initialize_report() {
    local report_file="$OUTPUT_DIR/diagnostic_report_$TIMESTAMP.txt"
    cat > "$report_file" << EOF
========================================
Codex Discord Bridge - 诊断报告
========================================
生成时间: $(date '+%Y-%m-%d %H:%M:%S')
主机: $(hostname)
用户: $(whoami)

EOF
    echo "$report_file"
}

append_section() {
    local report_file=$1
    local section_title=$2
    echo "" >> "$report_file"
    echo "========================================" >> "$report_file"
    echo "$section_title" >> "$report_file"
    echo "========================================" >> "$report_file"
}

collect_pm2_status() {
    local report_file=$1
    append_section "$report_file" "PM2 服务状态"
    pm2 list >> "$report_file" 2>&1
}

collect_pm2_info() {
    local report_file=$1
    append_section "$report_file" "PM2 详细信息"
    pm2 info "$SERVICE_NAME" >> "$report_file" 2>&1
}

collect_service_health() {
    local report_file=$1
    append_section "$report_file" "服务健康检查"
    
    echo "HTTP 健康端点:" >> "$report_file"
    curl -s http://127.0.0.1:8788/healthz 2>&1 | python3 -m json.tool >> "$report_file" 2>&1
    echo "" >> "$report_file"
    
    echo "根端点:" >> "$report_file"
    curl -s http://127.0.0.1:8788/ 2>&1 >> "$report_file"
}

collect_recent_errors() {
    local report_file=$1
    local errors_file="$LOG_DIR/$SERVICE_NAME.pm2.err.log"
    
    if [ -f "$errors_file" ]; then
        append_section "$report_file" "最近错误日志 (最后 50 行)"
        tail -50 "$errors_file" >> "$report_file"
    fi
}

collect_recent_output() {
    local report_file=$1
    local output_file="$LOG_DIR/$SERVICE_NAME.pm2.out.log"
    
    if [ -f "$output_file" ]; then
        append_section "$report_file" "最近输出日志 (最后 30 行)"
        tail -30 "$output_file" >> "$report_file"
    fi
}

collect_monitor_logs() {
    local report_file=$1
    local monitor_file="/tmp/codex-discord-bridge.monitor.log"
    
    if [ -f "$monitor_file" ]; then
        append_section "$report_file" "监控日志 (最后 20 行)"
        tail -20 "$monitor_file" >> "$report_file"
    fi
}

collect_process_info() {
    local report_file=$1
    append_section "$report_file" "进程信息"
    
    echo "相关进程:" >> "$report_file"
    ps aux | grep -E "(codex.*app-server|start-with-proxy)" | grep -v grep >> "$report_file" 2>&1
    
    echo "" >> "$report_file"
    echo "端口占用 8788:" >> "$report_file"
    if nc -z localhost 8788 2>/dev/null; then
        echo "Port 8788: 正在监听" >> "$report_file"
    else
        echo "Port 8788: 未监听" >> "$report_file"
    fi
}

collect_system_info() {
    local report_file=$1
    append_section "$report_file" "系统信息"
    
    echo "操作系统:" >> "$report_file"
    uname -a >> "$report_file"
    
    echo "" >> "$report_file"
    echo "CPU 使用率:" >> "$report_file"
    top -l 1 | head -10 | grep "CPU usage" >> "$report_file"
    
    echo "" >> "$report_file"
    echo "内存使用:" >> "$report_file"
    top -l 1 | head -10 | grep "PhysMem" >> "$report_file"
    
    echo "" >> "$report_file"
    echo "Node.js 版本:" >> "$report_file"
    node --version >> "$report_file"
    
    echo "" >> "$report_file"
    echo "NPM 版本:" >> "$report_file"
    npm --version >> "$report_file"
}

analyze_errors() {
    local report_file=$1
    append_section "$report_file" "错误分析"
    
    local errors_file="$LOG_DIR/$SERVICE_NAME.pm2.err.log"
    if [ -f "$errors_file" ]; then
        # 统计错误类型
        echo "错误统计 (最后 1000 行):" >> "$report_file"
        tail -1000 "$errors_file" | grep -i "error" | grep -oE "ERROR.*\[codex[a-z_]*::[a-z_]*\]" | sort | uniq -c | sort -rn >> "$report_file" 2>&1
        
        echo "" >> "$report_file"
        echo "常见错误消息:" >> "$report_file"
        tail -1000 "$errors_file" | grep -i "error" | grep -oE "state db.*|EADDRINUSE|EINVAL|ENOENT" | sort | uniq -c >> "$report_file" 2>&1
    fi
}

collect_config_info() {
    local report_file=$1
    append_section "$report_file" "配置信息"
    
    echo "环境变量 (部分):" >> "$report_file"
    printenv | grep -E "DISCORD|FEISHU|NODE|PATH$" >> "$report_file" 2>&1
    
    echo "" >> "$report_file"
    echo "PM2 配置文件:" >> "$report_file"
    if [ -f "/Users/aias/.openclaw/ai-bot-gateway/ecosystem.config.cjs" ]; then
        echo "✅ ecosystem.config.cjs 存在" >> "$report_file"
        head -20 /Users/aias/.openclaw/ai-bot-gateway/ecosystem.config.cjs >> "$report_file"
    fi
}

# 主函数
main() {
    local mode="${1:-full}"  # full|quick
    
    echo -e "${CYAN}========================================${NC}"
    echo -e "${CYAN}Codex Discord Bridge - 诊断工具${NC}"
    echo -e "${CYAN}========================================${NC}"
    echo ""
    
    local report_file=$(initialize_report)
    
    if [[ $mode == "full" ]]; then
        echo -e "${BLUE}收集完整诊断信息...${NC}"
        collect_pm2_status "$report_file"
        collect_pm2_info "$report_file"
        collect_service_health "$report_file"
        collect_process_info "$report_file"
        collect_recent_errors "$report_file"
        collect_recent_output "$report_file"
        collect_monitor_logs "$report_file"
        collect_system_info "$report_file"
        analyze_errors "$report_file"
        collect_config_info "$report_file"
    else
        echo -e "${BLUE}收集快速诊断信息...${NC}"
        collect_pm2_status "$report_file"
        collect_service_health "$report_file"
        collect_recent_errors "$report_file"
        collect_process_info "$report_file"
    fi
    
    echo ""
    echo -e "${GREEN}✓ 诊断报告已生成${NC}"
    echo "文件: $report_file"
    echo ""
    
    # 显示报告摘要
    echo "========================================"
    echo "诊断摘要"
    echo "========================================"
    
    if pm2 list | grep -q "$SERVICE_NAME.*online"; then
        echo -e "${GREEN}✓ PM2 服务: ONLINE${NC}"
    else
        echo -e "${RED}✗ PM2 服务: OFFLINE${NC}"
    fi
    
    if nc -z localhost 8788 2>/dev/null; then
        echo -e "${GREEN}✓ 端口 8788: 正常${NC}"
    else
        echo -e "${RED}✗ 端口 8788: 异常${NC}"
    fi
    
    if curl -s http://127.0.0.1:8788/healthz 2>&1 | grep -q '"ok":true'; then
        echo -e "${GREEN}✓ HTTP API: 正常${NC}"
    else
        echo -e "${RED}✗ HTTP API: 异常${NC}"
    fi
    
    # 检查错误数量
    local error_count=$(tail -100 "$LOG_DIR/$SERVICE_NAME.pm2.err.log" 2>/dev/null | grep -c "ERROR" || echo "0")
    if [[ $error_count -gt 0 ]]; then
        echo -e "${YELLOW}⚠ 最近错误: $error_count 个${NC}"
    else
        echo -e "${GREEN}✓ 最近错误: 无${NC}"
    fi
    
    echo ""
    echo "查看完整报告:"
    echo "  cat $report_file"
    echo ""
}

# 运行主函数
main "$@"