# PWA Starter

This is a PWA app scaffold. It's password protected and can be used on PC and Android phone.


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

# configure domain and generate certs
printf '%s\n' 'Define APP_DOMAIN subdomain.example.com' > apache/res/domain.conf
./apache/res/ctrl.sh

# start the app
docker network inspect proxy >/dev/null 2>&1 || docker network create proxy
docker compose up --build -d --force-recreate
docker compose -f apache/docker-compose.yml up --build -d --force-recreate
```
