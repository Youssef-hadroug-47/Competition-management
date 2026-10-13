#!/usr/bin/bash

sudo docker run --rm -p 3000:3000 \
  -e JWT_SECRET="2+OiDb81QQljfGyg2D45ikYdsNSkZV53koorR9jFpkw=" \
  -e DATABASE_URL="postgresql://postgres.kgdharwxngzmvgtwrwkp:youssefbacharkhadra@aws-0-eu-west-1.pooler.supabase.com:5432/postgres" \
  -e DATABASE_SSL=true -e CORS_ORIGINS="https://tournly.vercel.app" \
  -e DATABASE_SSL_REJECT_UNAUTHORIZED=false \
  $1
