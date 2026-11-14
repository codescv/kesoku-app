#!/usr/bin/env bash
# Build and deploy the Kesoku relay to Cloud Run (Blueprint §1.1).
#
# Required env:
#   GCP_PROJECT_ID     target project (Firebase-enabled)
#   ALLOWED_EMAILS     comma-separated Google accounts allowed to sign in
# Optional env:
#   GCP_REGION         default asia-east1
#   MEDIA_BUCKET       default kesoku-media-<PROJECT_NUMBER>
#   FIREBASE_PROJECT_ID default $GCP_PROJECT_ID
#   SERVICE_NAME       default kesoku-relay
#   SERVICE_ACCOUNT    default kesoku-relay@$GCP_PROJECT_ID.iam.gserviceaccount.com
#   AR_REPO            Artifact Registry docker repo, default kesoku
#   IMAGE_TAG          default: git short sha (+ -dirty)
#   EXTRA_CORS_ORIGINS extra origins for the media bucket CORS policy (comma-separated)
#   FIREBASE_WEB_API_KEY public Firebase web API key (enables the Web "Sign in with Google" popup)
#   FIREBASE_AUTH_DOMAIN default <FIREBASE_PROJECT_ID>.firebaseapp.com
#
# Flags:
#   --bootstrap   create (idempotently) the bucket, service account, IAM bindings, Artifact Registry repo
#                 and the two secrets (random values generated locally and never printed)
#   --local-build build with local docker instead of Cloud Build
#
# Secrets are only ever referenced via --set-secrets; nothing secret is stored in this repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BOOTSTRAP=0
LOCAL_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --bootstrap) BOOTSTRAP=1 ;;
    --local-build) LOCAL_BUILD=1 ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

: "${GCP_PROJECT_ID:?set GCP_PROJECT_ID}"
: "${ALLOWED_EMAILS:?set ALLOWED_EMAILS (comma-separated)}"
REGION="${GCP_REGION:-asia-east1}"
SERVICE_NAME="${SERVICE_NAME:-kesoku-relay}"
SERVICE_ACCOUNT="${SERVICE_ACCOUNT:-kesoku-relay@${GCP_PROJECT_ID}.iam.gserviceaccount.com}"
FIREBASE_PROJECT_ID="${FIREBASE_PROJECT_ID:-$GCP_PROJECT_ID}"
AR_REPO="${AR_REPO:-kesoku}"
ENGINE_SECRET="kesoku-relay-engine-token"
HMAC_SECRET="kesoku-device-hmac"

command -v gcloud >/dev/null || { echo "gcloud CLI not found" >&2; exit 1; }
PROJECT_NUMBER="$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')"
MEDIA_BUCKET="${MEDIA_BUCKET:-kesoku-media-${PROJECT_NUMBER}}"

if [[ -z "${IMAGE_TAG:-}" ]]; then
  IMAGE_TAG="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)"
  if [[ -n "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ]]; then IMAGE_TAG="${IMAGE_TAG}-dirty"; fi
fi
IMAGE="${REGION}-docker.pkg.dev/${GCP_PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}:${IMAGE_TAG}"

g() { gcloud --project="$GCP_PROJECT_ID" "$@"; }

random_secret() {
  # 64 random bytes, base64url, no newline. Never echoed to the terminal.
  head -c 64 /dev/urandom | base64 | tr -d '\n=' | tr '+/' '-_'
}

if [[ "$BOOTSTRAP" == 1 ]]; then
  echo "==> bootstrap: APIs"
  g services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com \
    secretmanager.googleapis.com iamcredentials.googleapis.com storage.googleapis.com >/dev/null

  echo "==> bootstrap: Artifact Registry repo ${AR_REPO}"
  g artifacts repositories describe "$AR_REPO" --location="$REGION" >/dev/null 2>&1 \
    || g artifacts repositories create "$AR_REPO" --repository-format=docker --location="$REGION" >/dev/null

  echo "==> bootstrap: service account ${SERVICE_ACCOUNT}"
  g iam service-accounts describe "$SERVICE_ACCOUNT" >/dev/null 2>&1 \
    || g iam service-accounts create "${SERVICE_ACCOUNT%%@*}" --display-name="Kesoku relay" >/dev/null
  # Self-signing V4 URLs without a key file.
  g iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT" \
    --member="serviceAccount:${SERVICE_ACCOUNT}" --role=roles/iam.serviceAccountTokenCreator >/dev/null

  echo "==> bootstrap: bucket gs://${MEDIA_BUCKET} (uniform access, no public read, 7-day lifecycle)"
  if ! g storage buckets describe "gs://${MEDIA_BUCKET}" >/dev/null 2>&1; then
    g storage buckets create "gs://${MEDIA_BUCKET}" --location="$REGION" --uniform-bucket-level-access \
      --public-access-prevention >/dev/null
  fi
  LIFECYCLE="$(mktemp)"
  trap 'rm -f "$LIFECYCLE"' EXIT
  printf '%s' '{"rule":[{"action":{"type":"Delete"},"condition":{"age":7}}]}' >"$LIFECYCLE"
  g storage buckets update "gs://${MEDIA_BUCKET}" --lifecycle-file="$LIFECYCLE" >/dev/null
  g storage buckets add-iam-policy-binding "gs://${MEDIA_BUCKET}" \
    --member="serviceAccount:${SERVICE_ACCOUNT}" --role=roles/storage.objectAdmin >/dev/null

  for s in "$ENGINE_SECRET" "$HMAC_SECRET"; do
    if ! g secrets describe "$s" >/dev/null 2>&1; then
      echo "==> bootstrap: secret ${s} (random value, not printed)"
      random_secret | g secrets create "$s" --replication-policy=automatic --data-file=- >/dev/null
    fi
    g secrets add-iam-policy-binding "$s" --member="serviceAccount:${SERVICE_ACCOUNT}" \
      --role=roles/secretmanager.secretAccessor >/dev/null
  done
  echo "    engine token: read it on the engine host with"
  echo "    gcloud secrets versions access latest --secret=${ENGINE_SECRET} --project=${GCP_PROJECT_ID}"
fi

echo "==> build ${IMAGE}"
if [[ "$LOCAL_BUILD" == 1 ]]; then
  docker build -f "$ROOT/apps/relay/Dockerfile" -t "$IMAGE" "$ROOT"
  gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet >/dev/null
  docker push "$IMAGE"
else
  CB="$(mktemp)"
  cat >"$CB" <<EOF
steps:
  - name: gcr.io/cloud-builders/docker
    env: ["DOCKER_BUILDKIT=1"]
    args: ["build", "-f", "apps/relay/Dockerfile", "-t", "${IMAGE}", "."]
images: ["${IMAGE}"]
EOF
  g builds submit "$ROOT" --config="$CB" --region="$REGION"
  rm -f "$CB"
fi

ENV_VARS="ALLOWED_EMAILS=${ALLOWED_EMAILS};FIREBASE_PROJECT_ID=${FIREBASE_PROJECT_ID};MEDIA_BUCKET=${MEDIA_BUCKET}"
if [[ -n "${FIREBASE_WEB_API_KEY:-}" ]]; then
  ENV_VARS="${ENV_VARS};FIREBASE_WEB_API_KEY=${FIREBASE_WEB_API_KEY};FIREBASE_AUTH_DOMAIN=${FIREBASE_AUTH_DOMAIN:-${FIREBASE_PROJECT_ID}.firebaseapp.com}"
fi

echo "==> deploy ${SERVICE_NAME} (${REGION})"
g run deploy "$SERVICE_NAME" \
  --image="$IMAGE" \
  --region="$REGION" \
  --service-account="$SERVICE_ACCOUNT" \
  --min-instances=1 --max-instances=1 \
  --concurrency=250 --timeout=3600 \
  --cpu=1 --memory=512Mi --no-cpu-throttling \
  --ingress=all --allow-unauthenticated \
  --set-secrets="ENGINE_TOKEN=${ENGINE_SECRET}:latest,DEVICE_HMAC_KEY=${HMAC_SECRET}:latest" \
  --set-env-vars="^;^${ENV_VARS}"

URL="$(g run services describe "$SERVICE_NAME" --region="$REGION" --format='value(status.url)')"

echo "==> media bucket CORS for ${URL} + native WebViews"
ORIGINS="\"${URL}\",\"https://localhost\",\"capacitor://localhost\""
if [[ -n "${EXTRA_CORS_ORIGINS:-}" ]]; then
  IFS=',' read -ra extra <<<"$EXTRA_CORS_ORIGINS"
  for o in "${extra[@]}"; do ORIGINS="${ORIGINS},\"${o}\""; done
fi
CORS="$(mktemp)"
printf '[{"origin":[%s],"method":["GET","HEAD","PUT"],"responseHeader":["Content-Type","Content-Length","x-goog-content-length-range"],"maxAgeSeconds":3600}]' "$ORIGINS" >"$CORS"
g storage buckets update "gs://${MEDIA_BUCKET}" --cors-file="$CORS" >/dev/null
rm -f "$CORS"

echo "==> done: ${URL}"
echo "    engine relay_url: ${URL/https:/wss:}/engine"
