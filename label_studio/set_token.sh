#!/bin/bash
# 保存 LS_API_KEY 到 .env，之后所有脚本自动读取，无需每次 export
# 用法：bash label_studio/set_token.sh <token>

ENV_FILE="$HOME/label_infra/.env"

if [ -z "$1" ]; then
    echo "用法：bash label_studio/set_token.sh <token>"
    echo ""
    echo "Token 获取方式："
    echo "  Label Studio → 右上角头像 → Account & Settings → Access Token"
    exit 1
fi

mkdir -p "$(dirname "$ENV_FILE")"

# 写入或更新 LS_API_KEY
if grep -q "^LS_REFRESH_TOKEN=" "$ENV_FILE" 2>/dev/null; then
    sed -i "s|^LS_REFRESH_TOKEN=.*|LS_REFRESH_TOKEN=$1|" "$ENV_FILE"
else
    echo "LS_REFRESH_TOKEN=$1" >> "$ENV_FILE"
fi
# 同步清掉旧的 API_KEY 避免混淆
sed -i "/^LS_API_KEY=/d" "$ENV_FILE" 2>/dev/null || true

echo "✅ Token 已保存到 $ENV_FILE"
echo "   后续直接运行 setup.sh / restart.sh，无需手动 export"
