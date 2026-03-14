#!/bin/bash

# 服务监控脚本
# 每 5 分钟检查一次服务健康状态

LOG_FILE="/tmp/codex-discord-bridge.monitor.log"
HEALTH_URL="http://127.0.0.1:8788/healthz"
PM2_APP_NAME="codex-discord-bridge"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

check_health() {
  local response=$(curl -s "$HEALTH_URL" 2>&1)
  
  if [[ $response == *'"ok":true'* && $response == *'"ready":true'* ]]; then
    return 0
  fi
  
  return 1
}

check_pm2_status() {
  local status=$(pm2 list | grep "$PM2_APP_NAME" -A 0 | awk '{print $10}')
  
  if [[ $status == "online" ]]; then
    return 0
  fi
  
  return 1
}

restart_service() {
  log "Service unhealthy, attempting restart..."
  
  # 先停止旧进程
  pm2 stop "$PM2_APP_NAME" >> "$LOG_FILE" 2>&1
  pm2 delete "$PM2_APP_NAME" >> "$LOG_FILE" 2>&1
  
  # 清理端口
  pkill -9 -f "codex.*app-server" >> "$LOG_FILE" 2>&1
  sleep 2
  
  # 启动服务
  cd /Users/aias/.openclaw/ai-bot-gateway
  pm2 start ecosystem.config.cjs >> "$LOG_FILE" 2>&1
  
  sleep 5
  
  if check_health; then
    log "Service restart successful"
    # 保存 PM2 状态
    pm2 save >> "$LOG_FILE" 2>&1
  else
    log "Service restart failed"
  fi
}

# 主逻辑
if ! check_health; then
  log "Health check failed"
  
  if check_pm2_status; then
    # PM2 运行中但服务不健康，重启服务
    restart_service
  else
    # PM2 没有运行，启动 PM2
    log "PM2 not running, starting service..."
    cd /Users/aias/.openclaw/ai-bot-gateway
    pm2 start ecosystem.config.cjs >> "$LOG_FILE" 2>&1
    sleep 5
    
    if check_health; then
      log "Service started successfully"
      pm2 save >> "$LOG_FILE" 2>&1
    else
      log "Service start failed"
    fi
  fi
else
  log "Health check passed"
fi
