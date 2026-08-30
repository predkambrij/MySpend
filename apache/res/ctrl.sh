#!/bin/sh
# Issue or renew a Let's Encrypt certificate using Cloudflare DNS.
# Use "./ctrl.sh selfsign" for a self-signed certificate instead.
set -eu

cd "$(dirname "$0")"
apache_dir=$(cd .. && pwd)

domain=$(awk '$1 == "Define" && $2 == "APP_DOMAIN" { print $3 }' domain.conf)
credentials="$apache_dir/secrets/cloudflare.ini"
letsencrypt="$apache_dir/letsencrypt"
certbot_image=certbot/dns-cloudflare:latest
staging="" # change to --staging for testing

if [ -z "$domain" ]; then
  echo "APP_DOMAIN is not defined in domain.conf" >&2
  exit 1
fi

if [ "${1:-}" = "selfsign" ]; then
  umask 077
  mkdir -p certs
  certificate_domain=${domain#*.}
  openssl req -x509 -newkey rsa:3072 -sha256 -days 3650 -nodes \
    -keyout certs/server.key -out certs/server.crt \
    -subj "/CN=*.$certificate_domain" \
    -addext "subjectAltName=DNS:$certificate_domain,DNS:*.$certificate_domain"
  chmod 600 certs/server.key
  exit 0
fi

if [ ! -f "$credentials" ]; then
  echo "missing $credentials" >&2
  exit 1
fi

umask 077
mkdir -p certs "$letsencrypt"

certbot() {
  docker run --rm -v "$letsencrypt:/etc/letsencrypt" -v "$credentials:/secrets/cloudflare.ini:ro" "$certbot_image" "$@"
}

certbot certonly \
  --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring \
  --dns-cloudflare --dns-cloudflare-credentials /secrets/cloudflare.ini --dns-cloudflare-propagation-seconds 30 \
  --cert-name "$domain" -d "$domain" $staging

# Copy as root in the container because Certbot's files are root-owned.
changed=$(docker run --rm --entrypoint sh \
  -v "$letsencrypt:/etc/letsencrypt:ro" -v "$PWD/certs:/certs" \
  -e DOMAIN="$domain" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  "$certbot_image" -c '
    if cmp -s "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" /certs/server.crt; then
      echo unchanged
    else
      cp -L "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" /certs/server.crt &&
        cp -L "/etc/letsencrypt/live/$DOMAIN/privkey.pem" /certs/server.key &&
        chmod 644 /certs/server.crt && chmod 600 /certs/server.key &&
        chown "$HOST_UID:$HOST_GID" /certs/server.crt /certs/server.key &&
        echo changed
    fi')

if [ "$changed" = "changed" ]; then
  echo "deployed new certificate to certs/"
  docker compose -f ../docker-compose.yml exec -T apacheproxy httpd -k graceful  || echo "warning: apache not reloaded; restart apacheproxy to pick it up" >&2
fi
