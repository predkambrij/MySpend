# MySpend

A password-protected spending tracker for desktop and mobile. Expenses and settings are stored in `data/myspend.sqlite`.

Add expenses with the `+` button. Select an expense to edit or delete it. The chart scrolls horizontally through historical periods; select a bar to view that period. The settings screen controls the display currency and aggregation period, and imports Spendee CSV exports in this column order:

```text
date,wallet,type,category,amount,currency,description,note,account
```

Wallet, type, category, note, and account are not stored. Income rows and duplicate expenses are skipped. Currencies are never converted; totals are displayed separately for each currency.

Settings also provides a Spendee-compatible CSV export. Fields not stored by MySpend are exported empty.


## Setup

```sh
# set permissions (only the owner may access the data)
sudo chown "$(id -u):$(id -g)" data/
chmod 700 data/

# generate password (single user)
read -r -s -p 'Password (minimum 20 characters): ' PWA_PASSWORD; printf '\n'
printf '%s\n' "$PWA_PASSWORD" | ./ctrl.sh create_config https://subdomain.example.com
unset PWA_PASSWORD
sudo chown 1000:1000 config.json

# configure HTTPS (the token needs Cloudflare DNS edit access, limited to this zone)
printf '%s\n' 'Define APP_DOMAIN subdomain.example.com' > apache/res/domain.conf
(umask 077; mkdir -p apache/secrets; read -r -s -p 'Cloudflare token: ' T; printf '\ndns_cloudflare_api_token = %s\n' "$T" > apache/secrets/cloudflare.ini)
# rerun periodically to renew
./apache/res/ctrl.sh
# or generate a self-signed certificate for local/testing
# ./apache/res/ctrl.sh selfsign

# start the app
docker network inspect proxy >/dev/null 2>&1 || docker network create proxy
docker compose up --build -d --force-recreate
docker compose -f apache/docker-compose.yml up --build -d --force-recreate
```

To sign out all devices (for example after a lost phone or a password change), delete `data/sessions.json` and restart the container.
