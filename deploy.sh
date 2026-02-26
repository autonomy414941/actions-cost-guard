#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
IMAGE_NAME="actions-cost-guard:latest"
CONTAINER_NAME="actions-cost-guard"
TRAEFIK_DYNAMIC_DIR="/data/coolify/proxy/dynamic"
PERSIST_DIR="$ROOT_DIR/../data/actions-cost-guard"

cd "$ROOT_DIR"

docker build -t "$IMAGE_NAME" .

docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
mkdir -p "$PERSIST_DIR"

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --network coolify \
  -e DATA_DIR=/data \
  -e PUBLIC_BASE_URL="https://actions-cost-guard.devtoolbox.dedyn.io" \
  -v "$PERSIST_DIR:/data" \
  "$IMAGE_NAME" >/dev/null

cp "$ROOT_DIR/infra/actions-cost-guard.traefik.yaml" "$TRAEFIK_DYNAMIC_DIR/actions-cost-guard.yaml"

echo "Deployed: https://actions-cost-guard.devtoolbox.dedyn.io"
