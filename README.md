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

## Roles, memberships and Discord linking

- **Founder** (`FOUNDER_USER`/`FOUNDER_PASSWORD`): can create/delete admins, is invisible to admins, and is the only one who sees the **Founder** tab (Discord OAuth app, account webhook).
- **Admin** (`ADMIN_ACCOUNTS` or created by the Founder): can create/delete users, rename accounts, change limits, add time, see linked Discord names/IDs and "X of limit" Microsoft accounts. Admins cannot delete other admins.
- **Membership**: when time runs out the account is locked for 24 h (nothing usable, bots stopped); if not extended, it is deleted together with its bots.
- **Discord linking**: in the Founder tab enter the Application ID, secret and public URL, then add `https://meltrovia.com/auth/discord/callback` as a redirect in the Discord Developer Portal (OAuth2). Once configured, users must link Discord before continuing. A link only changes when the user revokes the app in Discord; that is logged and can be sent to the webhook.
- Migration: the former `DASHBOARD_USER` account becomes the Founder (old variables still work as a fallback).

## Discord bot (tickets, shop, roles)

The bot runs inside the dashboard (discord.js). Setup:

1. Discord Developer Portal → New Application → **Bot** → enable **Server Members Intent** → copy the token.
2. Dashboard → **Founder** tab → paste the token, *Save token*, *Start bot*. Use the shown **invite link** to add the bot to your server, then move the bot's role above every role it should hand out.
3. The founder configures everything in the **Discord bot** tab (not visible to admins) and clicks *Save & post* for each panel. The bot restarts automatically with the dashboard. Admins only act inside Discord (their Discord roles) and see the **Purchases** tab.

Features: welcome/leave messages with placeholders, autorole, reaction roles, role toggle buttons, honeypot channel (kicks or bans anyone who writes in it), ticket panel (dropdown, categories, per-member limit, only chosen roles can close, channels named `ticket-from-<name>`), purchase panel (price per unit such as 1 € per week; the buyer enters how many and the total is calculated; payment methods, discounts, order ticket with current total, *Complete purchase* / *Cancel purchase* / *Set discount* for admins), star rating + feedback after a completed purchase (separate channels), `/kick`, `/ban`, `/unban`, `/purchases`. Completed purchases appear in the **Purchases** tab (members see their own via their linked Discord account, admins see all).

## Configuration (`.env`)

```
FOUNDER_USER=founder
FOUNDER_PASSWORD=a-long-unique-password
ADMIN_ACCOUNTS=name:password,name2:password2   # optional
PORT=3000
HOST=127.0.0.1
MC_VERSION=auto
COOKIE_SECURE=true
```

Never commit your real `.env`.

## Install on a VPS (Ubuntu/Debian)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
npm install
nano .env      # create it with the variables below
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
