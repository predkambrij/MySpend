# MySpend

A password-protected spending tracker for desktop and mobile. Expenses and settings are stored in `data/myspend.sqlite`.

Add expenses with the `+` button. Select an expense to edit or delete it. The chart scrolls horizontally through historical periods; select a bar to view that period. The settings screen controls the display currency and aggregation period, and imports Spendee CSV exports in this column order:

```text
date,wallet,type,category,amount,currency,description,note,account
```

Wallet, type, category, note, and account are not stored. Income rows and duplicate expenses are skipped. Currencies are never converted; totals are displayed separately for each currency.


## Setup

```sh
# set permissions
chmod 777 data/

# generate password (single user)
read -r -s -p 'Password (minimum 20 characters): ' PWA_PASSWORD; printf '\n'
printf '%s\n' "$PWA_PASSWORD" | ./ctrl.sh create_config https://subdomain.example.com
unset PWA_PASSWORD
# or
# echo '<20 char password>' | ./ctrl.sh create_config https://subdomain.example.com
sudo chown 1000:1000 config.json

# configure HTTPS (the token needs Cloudflare DNS edit access)
printf '%s\n' 'Define APP_DOMAIN subdomain.example.com' > apache/res/domain.conf
mkdir -p apache/secrets
printf '%s\n' 'dns_cloudflare_api_token = <token>' > apache/secrets/cloudflare.ini
chmod 600 apache/secrets/cloudflare.ini
# rerun periodically to renew
./apache/res/ctrl.sh
# or generate a self-signed certificate for local/testing
# ./apache/res/ctrl.sh selfsign

# start the app
docker network inspect proxy >/dev/null 2>&1 || docker network create proxy
docker compose up --build -d --force-recreate
docker compose -f apache/docker-compose.yml up --build -d --force-recreate
```
