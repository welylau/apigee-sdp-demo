#!/bin/bash
# ==============================================================================
# Deploys the WebUI to Cloud Run behind IAP, with an optional custom domain.
# Idempotent: safe to re-run after code changes.
#
#   ./WebUI/deploy-cloudrun.sh
#
# Overrides: PROJECT, REGION, SERVICE, DOMAIN, DNS_ZONE, IAP_MEMBER
# ==============================================================================
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[ -f "$DIR/.env" ] && { set -a; . "$DIR/.env"; set +a; }

PROJECT="${PROJECT:-YOUR_GCP_PROJECT_ID}"
REGION="${REGION:-asia-southeast1}"
SERVICE="${SERVICE:-apigee-sdp-demo-ui}"
DOMAIN="${DOMAIN:-sdp.apigee-demo.com}"
DNS_ZONE="${DNS_ZONE:-apigee-demo-com}"
IAP_MEMBER="${IAP_MEMBER:-domain:google.com}"
PROXY_URL="${APIGEE_PROXY_URL:-https://YOUR_APIGEE_IP.nip.io/gemini-sdp-proxy}"
SA_NAME="${SERVICE}"
SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
SECRET="${SERVICE}-apigee-api-key"
: "${APIGEE_API_KEY:?APIGEE_API_KEY missing: run ./setup-apigee-resources.sh first}"

g() { gcloud --project="$PROJECT" --quiet "$@"; }
PROJECT_NUMBER=$(g projects describe "$PROJECT" --format='value(projectNumber)')

echo "▶ APIs"
g services enable run.googleapis.com iap.googleapis.com secretmanager.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com logging.googleapis.com >/dev/null

echo "▶ Runtime service account: $SA"
g iam service-accounts describe "$SA" >/dev/null 2>&1 || \
  g iam service-accounts create "$SA_NAME" --display-name="SDP demo WebUI (Cloud Run)"
# Read-only access to the apigee-sdp-logs audit trail for the admin drawer.
g projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" \
  --role=roles/logging.viewer --condition=None >/dev/null

echo "▶ Secret: $SECRET"
g secrets describe "$SECRET" >/dev/null 2>&1 || g secrets create "$SECRET" --replication-policy=automatic
CURRENT=$(g secrets versions access latest --secret="$SECRET" 2>/dev/null || true)
[ "$CURRENT" = "$APIGEE_API_KEY" ] || printf '%s' "$APIGEE_API_KEY" | g secrets versions add "$SECRET" --data-file=- >/dev/null
g secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:$SA" \
  --role=roles/secretmanager.secretAccessor >/dev/null

echo "▶ Cloud Run deploy (source build) with IAP"
# max-instances=1: the demo audit store lives in the instance.
g run deploy "$SERVICE" --source="$DIR" --region="$REGION" \
  --service-account="$SA" --no-allow-unauthenticated --iap \
  --set-secrets="APIGEE_API_KEY=${SECRET}:latest" \
  --set-env-vars="GCP_PROJECT_ID=${PROJECT},APIGEE_PROXY_URL=${PROXY_URL}" \
  --min-instances=0 --max-instances=1 --cpu=1 --memory=512Mi --timeout=120 \
  --labels=app=apigee-sdp-demo,managed-by=deploy-cloudrun

echo "▶ IAP: service agent may invoke the service; $IAP_MEMBER may pass IAP"
g beta services identity create --service=iap.googleapis.com >/dev/null 2>&1 || true
g run services add-iam-policy-binding "$SERVICE" --region="$REGION" \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-iap.iam.gserviceaccount.com" \
  --role=roles/run.invoker >/dev/null
g iap web add-iam-policy-binding --resource-type=cloud-run --service="$SERVICE" --region="$REGION" \
  --member="$IAP_MEMBER" --role=roles/iap.httpsResourceAccessor --condition=None >/dev/null

if [ -n "$DOMAIN" ]; then
  echo "▶ Domain mapping: $DOMAIN"
  g beta run domain-mappings describe --domain="$DOMAIN" --region="$REGION" >/dev/null 2>&1 || \
    g beta run domain-mappings create --service="$SERVICE" --domain="$DOMAIN" --region="$REGION"
  FQDN="${DOMAIN}."
  EXISTING=$(g dns record-sets list --zone="$DNS_ZONE" --name="$FQDN" --type=CNAME --format='value(rrdatas[0])' 2>/dev/null || true)
  if [ -z "$EXISTING" ]; then
    g dns record-sets create "$FQDN" --zone="$DNS_ZONE" --type=CNAME --ttl=300 --rrdatas=ghs.googlehosted.com.
  elif [ "$EXISTING" != "ghs.googlehosted.com." ]; then
    echo "  ⚠️  $FQDN already has CNAME $EXISTING, not changing it"
  fi
fi

URL=$(g run services describe "$SERVICE" --region="$REGION" --format='value(status.url)')
echo "✅ $SERVICE deployed: $URL${DOMAIN:+  |  https://$DOMAIN (certificate can take 15-60 min)}"
