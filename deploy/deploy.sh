#!/usr/bin/env bash
set -euo pipefail
umask 077
cd "$(dirname "$0")"

release_image=${1:?Usage: bash deploy.sh ghcr.io/OWNER/REPO:COMMIT_SHA}
if [[ ! "$release_image" =~ ^ghcr\.io/[a-z0-9._/-]+:[a-f0-9]{40}$ ]]; then
  echo "Expected a GHCR image tagged with a full commit SHA." >&2
  exit 1
fi
export ASTRA_IMAGE="$release_image"

# The same lock also protects manual deploys from overlapping Actions runs.
exec 9>.deploy.lock
flock -n 9 || { echo "Another deployment is running." >&2; exit 1; }
test -f .env || { echo "Create the server .env first." >&2; exit 1; }
chmod 600 .env

# Read deployment state as data, never as shell code.
current_image=""
previous_image=""
if [[ -f .release.env ]]; then
  while IFS='=' read -r key value || [[ -n "$key" ]]; do
    case "$key" in
      ASTRA_IMAGE) current_image="$value" ;;
      PREVIOUS_ASTRA_IMAGE) previous_image="$value" ;;
      "") continue ;;
      *) echo "Invalid release state; refusing deployment." >&2; exit 1 ;;
    esac
  done < .release.env
  if [[ ! "$current_image" =~ ^ghcr\.io/[a-z0-9._/-]+:[a-f0-9]{40}$ ]] ||
    [[ -n "$previous_image" && ! "$previous_image" =~ ^ghcr\.io/[a-z0-9._/-]+:[a-f0-9]{40}$ ]]; then
    echo "Invalid release state; refusing deployment." >&2
    exit 1
  fi
fi
if [[ "$current_image" != "$ASTRA_IMAGE" ]]; then
  previous_image="$current_image"
fi

cleanup_release_images() {
  local images container_ids used_image_ids="" repository tag image_id reference container_id
  local -a containers=()
  if ! images=$(docker image ls --no-trunc --format '{{.Repository}} {{.Tag}} {{.ID}}'); then
    return 1
  fi
  if ! container_ids=$(docker ps -aq); then
    return 1
  fi
  if [[ -n "$container_ids" ]]; then
    while IFS= read -r container_id; do
      containers+=("$container_id")
    done <<< "$container_ids"
    if ! used_image_ids=$(docker container inspect --format '{{.Image}}' "${containers[@]}"); then
      return 1
    fi
  fi

  local cleanup_failed=0
  while read -r repository tag image_id; do
    [[ "$repository" == "${ASTRA_IMAGE%:*}" ]] || continue
    [[ "$tag" =~ ^[a-f0-9]{40}(-migrate)?$ ]] || continue
    reference="$repository:$tag"
    case "$reference" in
      "$ASTRA_IMAGE"|"$ASTRA_IMAGE-migrate"|"$previous_image"|"$previous_image-migrate") continue ;;
    esac
    # Protect running and stopped containers, including images with multiple tags.
    [[ $'\n'"$used_image_ids"$'\n' == *$'\n'"$image_id"$'\n'* ]] && continue
    if ! docker image rm "$reference"; then
      cleanup_failed=1
    fi
  done <<< "$images"
  return "$cleanup_failed"
}

docker compose --profile tools config --quiet
case "${2:-}" in
  "") docker compose --profile tools pull bot migrate postgres ;;
  --loaded-images)
    docker image inspect "$ASTRA_IMAGE" "$ASTRA_IMAGE-migrate" >/dev/null
    docker compose pull postgres
    ;;
  *) echo "Unknown deployment option." >&2; exit 1 ;;
esac
docker compose up -d --wait --wait-timeout 120 postgres

# Keep one polling process; do not restart old code after a failed migration.
docker compose stop bot
mkdir -p backups
backup_path="backups/$(date -u +%Y%m%dT%H%M%SZ).dump"
docker compose exec -T postgres pg_dump -U astra -d astra -Fc > "$backup_path.tmp"
mv "$backup_path.tmp" "$backup_path"
docker compose run --rm --no-deps migrate
if ! docker compose up -d --no-deps --wait --wait-timeout 180 bot; then
  docker compose stop bot
  echo "Bot startup failed; stopped it to prevent a restart loop. Inspect bot logs." >&2
  exit 1
fi
printf 'ASTRA_IMAGE=%s\nPREVIOUS_ASTRA_IMAGE=%s\n' "$ASTRA_IMAGE" "$previous_image" > .release.env.tmp
mv .release.env.tmp .release.env
echo "Deployment healthy. Database backup: $backup_path"
if ! cleanup_release_images; then
  echo "Warning: image cleanup incomplete; deployment remains healthy. Check disk usage." >&2
fi
