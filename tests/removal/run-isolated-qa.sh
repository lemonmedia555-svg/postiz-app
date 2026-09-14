#!/usr/bin/env bash
set -euo pipefail
qa_root=/opt/creatu-removal-qa-20260914
qa_network=creatu-removal-qa-20260914
test "$(pwd)" = "$qa_root"
test -f "$qa_root/jest.removal.config.cjs"
if ! docker network inspect "$qa_network" >/dev/null 2>&1; then
  docker network create --internal --label creatu.task=removal-qa-20260914 "$qa_network"
fi
if ! docker container inspect creatu-removal-qa-db >/dev/null 2>&1; then
  docker run -d --rm --name creatu-removal-qa-db --network "$qa_network" \
    --label creatu.task=removal-qa-20260914 --memory 256m \
    -e POSTGRES_USER=qa -e POSTGRES_DB=creatu_removal_qa -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17-alpine
fi
if ! docker container inspect creatu-removal-qa-redis >/dev/null 2>&1; then
  docker run -d --rm --name creatu-removal-qa-redis --network "$qa_network" \
    --label creatu.task=removal-qa-20260914 --memory 96m redis:7.2-alpine
fi
if ! docker container inspect creatu-removal-qa-temporal >/dev/null 2>&1; then
  docker run -d --rm --name creatu-removal-qa-temporal --network "$qa_network" \
    --label creatu.task=removal-qa-20260914 --memory 512m \
    --entrypoint temporal temporalio/admin-tools:1.28.1-tctl-1.18.4-cli-1.4.1 \
    server start-dev --ip 0.0.0.0 --headless --search-attribute postId=Keyword --search-attribute organizationId=Keyword
fi
for attempt in 1 2 3; do
  if docker exec creatu-removal-qa-db pg_isready -U qa -d creatu_removal_qa >/dev/null; then break; fi
  sleep 2
done
docker exec creatu-removal-qa-db pg_isready -U qa -d creatu_removal_qa
for attempt in 1 2 3; do
  if docker exec creatu-removal-qa-temporal temporal operator cluster health >/dev/null 2>&1; then break; fi
  sleep 2
done
docker exec creatu-removal-qa-temporal temporal operator cluster health
docker run --rm --name creatu-removal-qa-tests --network "$qa_network" --memory 2048m \
  --label creatu.task=removal-qa-20260914 \
  -e DATABASE_URL=postgresql://qa@creatu-removal-qa-db:5432/creatu_removal_qa \
  -e REDIS_URL=redis://creatu-removal-qa-redis:6379 \
  -e REMOVAL_QA_TEMPORAL=creatu-removal-qa-temporal:7233 \
  -e REMOVAL_QA=1 -e NODE_OPTIONS=--max-old-space-size=1536 \
  -v "$qa_root/libraries:/app/libraries:ro" -v "$qa_root/apps:/app/apps:ro" \
  -v "$qa_root/tests:/app/tests:ro" -v "$qa_root/jest.removal.config.cjs:/app/jest.removal.config.cjs:ro" \
  -v "$qa_root/tsconfig.base.json:/app/tsconfig.base.json:ro" \
  ghcr.io/lemonmedia555-svg/postiz-app:v2.6 sh -ec '
    pnpm exec prisma generate --schema libraries/nestjs-libraries/src/database/prisma/schema.prisma
    pnpm exec prisma db push --schema libraries/nestjs-libraries/src/database/prisma/schema.prisma --skip-generate
    pnpm exec jest --config jest.removal.config.cjs --runInBand
  '
