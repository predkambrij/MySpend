#!/bin/sh
set -eu

cd "$(dirname "$0")"
domain=$(awk '$1 == "Define" && $2 == "APP_DOMAIN" { print $3 }' domain.conf)
certificate_domain=${domain#*.}
umask 077

openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=*.$certificate_domain" \
  -addext "subjectAltName=DNS:$certificate_domain,DNS:*.$certificate_domain"

chmod 600 certs/server.key
