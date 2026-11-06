# Meltrovia Network – Bot Dashboard

A Minecraft bot network (Mineflayer) with a web dashboard. Every user connects **their own Microsoft / Minecraft
account**; the admin decides how many accounts each user may connect.

## Dashboard tabs

| Tab | Who | What |
| --- | --- | --- |
| Overview | everyone | Stats, account limit, quick add, bot list |
| Bots | everyone | Connect / disconnect bots, tasks (AFK, fishing, trading), per-bot settings (admin) |
| Inventory | everyone | Item grid per bot, select items, drop selected (with amount for stacks), drop everything |
| Mining | admin | Shared mining area, tools, storage chest, auto-drop list |
| Automation | admin | Auto Eat, Minecraft version |
| Console | everyone | Chat / commands and the activity log (filterable) |
| Accounts | admin | Create users, set each user's Minecraft account limit and lifetime, view as user |
| Settings | everyone | Profile and password |

## Accounts and limits

- Regular users cannot add bots by name. They press **Add Microsoft account**, sign in with the device code and the
  account becomes theirs. They only see and control their own bots.
- In **Accounts** the admin sets *Minecraft account limit* per user (0–100). With a limit of `1` the user can connect
  exactly one Minecraft account. The limit can be changed at any time; lowering it never removes existing accounts.
- Removing a bot deletes its saved Microsoft login and frees the slot. Deleting a user removes their bots as well.
- Users can only connect their bots to public server addresses (no localhost / private networks).
- Existing users created before this version have a limit of `0` until the admin raises it.

## Per-bot settings (admin)

- **Join / reconnect command:** a chat message or `/command` the bot sends once it is inside the server, after a
  configurable delay – only after a reconnect, or after every join.
- **After death:** command after respawn and an optional Discord webhook.
- **Sneak:** keep the bot crouching.

The server-side physics fix logs (knockback, "physics fix active") are kept out of the activity log.

## Install on a VPS (Ubuntu/Debian)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
npm install
cp .env.example .env && nano .env      # set a long DASHBOARD_PASSWORD
npm start
```

Run it permanently with pm2:

```bash
sudo npm install -g pm2
pm2 start src/index.js --name meltrovia-dashboard
pm2 save && pm2 startup
```

### HTTPS with Caddy

```
meltrovia.com {
    reverse_proxy 127.0.0.1:3000
}
```

Set `HOST=127.0.0.1` and `COOKIE_SECURE=true` in `.env`; only open ports 80 and 443.

## Development

```bash
npm test
```

`.env` and `data/` (users, Microsoft logins, settings) must never be committed.
