# Ammon Family Values

A shared family budget that installs on Android like an app, updates live for everyone, and stores **only numbers**: no names, no locations, no user info. Everything is encrypted on the phones before it is synced.

- **Client:** installable web app (PWA): plain HTML/CSS/JS, no build step, works offline.
- **Server:** one zero-dependency Node file (`server/server.js`) that relays encrypted records in real time.
- **Needs:** Node 18+ to run the server. Nothing to `npm install`.

## What is stored, and where

| Thing | Where it lives |
|---|---|
| Category labels ("Groceries"), months, planned and actual amounts | Encrypted on each phone (AES-256-GCM). The server only holds ciphertext. |
| Family key | Only on the family's phones, inside the invite link after the `#` (browsers never send that part to a server). With the optional PIN lock on, it is stored on the phone only in locked form. |
| Names, emails, accounts, locations, devices | Nowhere. There are no accounts. |
| What the server *can* see | That a room exists, how many records it has, their sizes, and when they change. Your IP address is used only for in-memory rate limiting and is never logged or saved. |

Every phone keeps a full (encrypted) copy. If the server is wiped (free hosts do this), the phones re-upload everything automatically.

## Run it on your computer

```bash
node server/server.js          # http://localhost:8787
npm test                       # 26 automated checks (starts its own servers)
```

`localhost` works for trying it out. Phones need **HTTPS** to install the app and to use encryption.

## Put it online for free (my recommendation: Render)

1. Put this folder in a GitHub repo (private is fine).
2. On render.com either choose **New → Blueprint** and pick the repo (it reads `render.yaml`), or **New → Web Service** with runtime **Node**, start command `node server/server.js`, plan **Free**, and the environment variable `TRUST_PROXY=1`.
3. Render gives you a permanent `https://something.onrender.com` address. That is your app's address.

Free-tier behaviour (per [Render's docs](https://render.com/docs/free)): it sleeps after 15 minutes idle and takes about a minute to wake; its disk is wiped when it sleeps or restarts; they say not to use free instances for production. Because the phones hold the data, the wipes are harmless. The cost is a slow first sync after a long idle. **I have not deployed to Render myself.** `render.yaml` follows Render's blueprint field names but has never been run.

Alternative: run `node server/server.js` on an always-on computer and expose it with a Cloudflare Tunnel. The tunnel is free, but a permanent address needs a domain you own. The free temporary "quick tunnel" addresses change on every restart.

A `Dockerfile` is included for any container host (never built: there was no Docker engine available where I worked).

Settings (environment variables): `PORT`, `DATA_FILE` (default `data/rooms.json`), `TRUST_PROXY=1` behind a proxy, `MAX_ROOMS`, `MAX_RECORDS`, `CREATE_BURST`.

## Install on Android

1. Open your https address in **Chrome** on the phone.
2. Tap **⋮ → Install app** (or **Add to Home screen**). It now opens full-screen like any app.
3. First phone: **Set up our budget**. The guided setup asks for each value one at a time.
4. At the end, tap **Invite my family** (or **⋮ menu → Invite family**). Send the link, or let a family member scan the QR code on your screen with their camera. Each person opens it once, and the phone remembers.

Treat the invite link like a house key: anyone with it can see and edit the budget, and nobody can recover the data if every copy of the key is lost.

## Using it

- **Guided setup** asks for one value per screen. Each screen has an **"I'm asking for"** line (for example "Net income: your take-home pay after taxes") and an **(i)** button. Hover over it on a computer, or tap it on a phone, for a longer explanation. The wording lives in `HELP` in `public/model.js` if you want to change it (for instance to ask for gross income instead of net).
- **Big boxes:** type a number and it saves by itself; everyone's screen updates live (the pill at the top says **Live**, **Offline, saved here**, etc.).
- **+ Add spending** (or **+ Add money received**) on each item: type `12.50` and it is added to the running total. **Subtract** is there for refunds and mistakes.
- Tap an item's name to rename or delete it; **+ Add income / + Add expense** adds more.
- Arrows at the top change months. Menu → **Copy last month's planned amounts** saves retyping; **Guided setup for this month** walks through everything again.
- **App lock (PIN):** Menu → *Turn on app lock*. 4 to 8 numbers, asked when the app opens and again after a minute away. Five wrong tries makes you wait 30 seconds. **I forgot my PIN** removes the budget from that phone only; rejoin with an invite link.
- **Remove someone:** Menu → *Remove someone: make a new key*. The budget moves to a new room under a new key, the old room is deleted, and you get a new invite link to send to everyone you still want in. Phones with the old link are signed out.
- Menu also has currency, extra-large text, **Delete all data from the server**, and **Remove this budget from this phone**.
- Works offline: edits are queued on the phone and sent when it reconnects.

## What was and wasn't verified

- **Verified (automated, `npm test`, 26 checks):** the real server and real client code: live sync, concurrent edits, offline queue, server restart, full server wipe and recovery, delete-all, wrong-key rejection, input validation, rate limiting, that the server's data file contains no readable names, labels, amounts, key or token, the PIN lock (right PIN, wrong PIN, tampering), the new-key move (old key locked out, new key sees the same numbers, failures leave the old budget intact, a lost reply to the delete), the QR structure, the setup help text, that every file the app needs is in the offline cache list, and a 150-edit offline backlog draining through the server's rate limit.
- **Verified (headless Chrome at phone size, two separate "phones"):** guided setup, the "I'm asking for" help and (i) button, invite link, live edits both ways, quick add and subtract, the QR code on screen (decoded by a software scanner back to the exact invite link; separately, 450 realistic invite-link QR codes were run through two independent scanners, which read 450 and 449 of them, and the one miss read fine at another image size), PIN lock (set, restart, wrong and right PIN, lock after two minutes away, wait after five wrong tries, turn off), the new-key flow with a second phone being signed out and rejoining, reload, month change, dark mode, extra-large text, and a layout sweep for sideways overflow on every screen and box.
- **Not verified:** a real Android device, installing it as an app, the offline service worker across a cold start, real camera scanning of the QR code (it decodes with a software scanner), and any hosted deployment (Render, Cloudflare, Docker).

## Known limits

- **Two people adding to the same item at the same instant:** the last save wins, so one of the two amounts can be lost. Each add shows the new total so you can notice, but a true fix is in the list below.
- **PIN lock is a casual lock.** The key is stored only in locked form, but a 4 to 8 digit PIN can be guessed offline by someone who copies the phone's storage. It keeps out someone who picks up an unlocked phone, not a determined attacker.
- **Removing someone cannot take back what they already saw,** and anyone who still has a copy of the old link can read old data they already downloaded. The new key only stops future access.
- During a new-key move, edits that other phones make in those few seconds are not copied. Do it when nobody is editing.
- The server can see record counts, sizes and timing (not content).
- It is a PWA, not a Play Store APK (see below).

## What to extend first

1. **Test on a real phone and deploy it.** Everything else depends on this.
2. **Make adds conflict-proof:** store each "add spending" as its own record and sum them, instead of overwriting one total. That also gives you a history.
3. **Yearly overview and rollover** of leftover money between months.
4. **Biometric unlock** (WebAuthn) in place of, or next to, the PIN.
5. **Real APK** via Bubblewrap (Trusted Web Activity) once it is hosted at a permanent https address.
6. **Encrypted backup export.**

## Layout

```
server/server.js      sync server + static file host (zero dependencies)
public/index.html     screens and dialogs
public/style.css      warm theme, large touch targets, dark mode
public/app.js         UI, guided setup, quick add, lock, new-key flow
public/model.js       budget state, money math, setup help text (no DOM)
public/vault.js       key derivation and AES-GCM encryption
public/sync.js        real-time sync, offline queue, reconnect, server-wipe recovery
public/lock.js        PIN lock: wraps the family key with a PIN-derived key
public/rotate.js      "make a new key": moves the budget to a new room, then deletes the old one
public/qr.js          QR code generator (no libraries)
public/sw.js          offline app shell
test/e2e.mjs          end-to-end tests: sync, security, resilience
test/features.mjs     PIN lock, new key, QR, help text, backlog
render.yaml           Render deploy file (untested)
Dockerfile            container build (untested)
```
