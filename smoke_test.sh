#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://actions-cost-guard.46.225.49.219.nip.io}"

health_payload="$(curl -fsS "$BASE_URL/api/health")"
status="$(printf '%s' "$health_payload" | jq -r '.status')"
if [[ "$status" != "ok" ]]; then
  echo "health check failed: $health_payload" >&2
  exit 1
fi

estimate_payload="$(curl -fsS -X POST "$BASE_URL/api/estimate" \
  -H 'content-type: application/json' \
  --data '{"workflowYaml":"name: CI\non: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: npm ci\n      - run: npm test","monthlyRuns":420,"budgetUsd":20,"policyMode":"warn","source":"smoke","selfTest":true}')"

session_id="$(printf '%s' "$estimate_payload" | jq -r '.sessionId')"
decision="$(printf '%s' "$estimate_payload" | jq -r '.estimate.summary.policyDecision')"
if [[ -z "$session_id" || "$session_id" == "null" || -z "$decision" || "$decision" == "null" ]]; then
  echo "estimate failed: $estimate_payload" >&2
  exit 1
fi

checkout_payload="$(curl -fsS -X POST "$BASE_URL/api/billing/checkout" \
  -H 'content-type: application/json' \
  --data "{\"sessionId\":\"$session_id\",\"source\":\"smoke\",\"selfTest\":true}")"
checkout_mode="$(printf '%s' "$checkout_payload" | jq -r '.checkoutMode')"
if [[ "$checkout_mode" != "payment_link" ]]; then
  echo "checkout failed: $checkout_payload" >&2
  exit 1
fi

metrics_payload="$(curl -fsS "$BASE_URL/api/metrics")"
estimate_count="$(printf '%s' "$metrics_payload" | jq -r '.totals.includingSelfTests.estimate_generated')"
if [[ "$estimate_count" == "null" || "$estimate_count" -lt 1 ]]; then
  echo "metrics missing estimate_generated: $metrics_payload" >&2
  exit 1
fi

echo "healthStatus=$status"
echo "policyDecision=$decision"
echo "checkoutMode=$checkout_mode"
echo "estimateGeneratedIncludingSelfTests=$estimate_count"
