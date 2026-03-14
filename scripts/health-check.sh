#!/bin/bash

# Health check script for PM2
# Returns 0 if healthy, 1 if unhealthy

MAX_RETRIES=3
RETRY_DELAY=2

for ((i=1; i<=$MAX_RETRIES; i++)); do
  RESPONSE=$(curl -s http://127.0.0.1:8788/ 2>/dev/null)
  
  if [[ $RESPONSE == *'"ok":true'* ]]; then
    echo "Health check passed"
    exit 0
  fi
  
  if [[ $i -lt $MAX_RETRIES ]]; then
    echo "Health check failed (attempt $i/$MAX_RETRIES), retrying..."
    sleep $RETRY_DELAY
  fi
done

echo "Health check failed after $MAX_RETRIES attempts"
exit 1
