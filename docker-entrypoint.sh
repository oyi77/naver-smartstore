#!/bin/sh
# Note: set -e is removed so we can handle chmod errors manually

# Data directory path
DATA_DIR="/app/data"

echo "[Entrypoint] Checking data directory: $DATA_DIR"

# Ensure data directory exists
if [ ! -d "$DATA_DIR" ]; then
    echo "[Entrypoint] Creating $DATA_DIR"
    mkdir -p "$DATA_DIR"
fi

# Fix permissions
# Try to open up permissions, but don't fail if restricted (e.g. by bind mount)
echo "[Entrypoint] Attempting to set permissions (777) on $DATA_DIR..."
chmod -R 777 "$DATA_DIR" || echo "[Entrypoint] ⚠️ Warning: chmod failed (Operation not permitted). This is common with host mounts. verifying write access..."

# Test writability
TEST_FILE="$DATA_DIR/.write_test"
if touch "$TEST_FILE"; then
    echo "[Entrypoint] ✅ Write access confirmed."
    rm "$TEST_FILE"
else
    echo "[Entrypoint] ❌ Error: Cannot write to $DATA_DIR. Please check host directory permissions."
    echo "[Entrypoint] The container is running as root, but the host filesystem is rejecting writes."
    exit 1
fi

# Execute the main command
echo "[Entrypoint] Starting application..."
exec "$@"
