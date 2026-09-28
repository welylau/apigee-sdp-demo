#!/usr/bin/env bash
set -e

# ==============================================================================
# Deployment Script for gemini-sdp-proxy in YOUR_GCP_PROJECT_ID
# Uses Application Default Credentials by default (the gcloud user token is
# rejected by apigee.googleapis.com with ACCESS_TOKEN_TYPE_UNSUPPORTED).
# Override with: TOKEN=<token> ./deploy.sh
# Run ./setup-apigee-resources.sh once first to create the API product and apps.
# ==============================================================================

ORG="${APIGEE_ORG:-YOUR_GCP_PROJECT_ID}"
ENV="${APIGEE_ENV:-default-dev}"
PROXY_NAME="gemini-sdp-proxy"
RUNTIME_SA="${APIGEE_RUNTIME_SA:-sa-apigee-aiservices@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com}"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOKEN="${TOKEN:-$(gcloud auth application-default print-access-token)}"

echo "=================================================================="
echo "📦 Uploading API Proxy Bundle '$PROXY_NAME' to Apigee Org '$ORG'..."
echo "=================================================================="
apigeecli apis create bundle \
  -n "$PROXY_NAME" \
  -f "$DIR/$PROXY_NAME/apiproxy" \
  -o "$ORG" \
  -t "$TOKEN"

echo ""
echo "=================================================================="
echo "🚀 Deploying '$PROXY_NAME' to environment '$ENV'..."
echo "   Service Account: $RUNTIME_SA"
echo "=================================================================="
apigeecli apis deploy \
  -n "$PROXY_NAME" \
  -e "$ENV" \
  -s "$RUNTIME_SA" \
  -o "$ORG" \
  --ovr \
  --wait \
  -t "$TOKEN"

echo ""
echo "✅ Deployment complete and READY in $ORG / $ENV!"
