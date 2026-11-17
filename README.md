# Ammon Family Values

A family budget that installs on Android like an app and lives **only on your own phone**. It stores **only numbers** (and the labels you give them): no names, no locations, no accounts. There is no server. To share, one person emails a locked budget file and the other brings it in.

- **What it is:** an installable web app (PWA): plain HTML/CSS/JS in `docs/`, no build step, nothing to `npm install`.
- **What it talks to:** nothing. The app's code contains no network calls. After the first visit it runs with no internet.
- **Fun part:** during guided setup, every answer earns a quick puzzle (mini sudoku, word scramble, mini crossword).

## What is stored, and where

| Thing | Where it lives |
|---|---|
| Item labels ("Groceries"), months, planned and actual amounts | On the phone, sealed with AES-256-GCM before being written to the browser's storage. |
| The budget key | On that phone only. With the PIN lock on, it is kept only in locked form. |
| Budget files you send | Wherever you send them (your email). They are locked with your sharing password, so email only carries scrambled text. |
| The sharing password | In your heads, and remembered on each phone (sealed with the budget key). |
| Names, emails, accounts, locations, devices | Nowhere. |

## Sharing by email

1. **You:** Menu → **Send my budget to family**. The first time, you choose a **sharing password** (at least 8 characters; a few random words is best). Then **Email or share the file** opens Android's share sheet: pick your email app and send it. (**Save the file** and **Copy it as text** are there too.)
2. **Tell her the password in person or on the phone.** Never in the same email as the file.
3. **Her, first time:** open the app → **Open a budget file** → choose the attachment (save it to the phone first) → type the sharing password. Her phone now has the same budget and remembers the password.
4. **Her, from then on:** she updates numbers, then Menu → **Send my budget to family** and emails you the file.
5. **You:** Menu → **Bring in a budget file from family** → choose it. You see **exactly what will change** (for example "Groceries · Spent: $102.50 → $117.50") and nothing is updated until you tap **Update my budget**.

How two copies are combined: **for each amount, the most recently changed one wins.** Amounts the file doesn't have newer values for are left alone, so your own newer edits survive. If you both changed the same amount since you last swapped files, the preview marks it **"You changed this too"** so you can fix the total by hand if needed.

A saved budget file is also your **backup**: keep one somewhere safe.

## Puzzles

- In guided setup, each question you answer is followed by a short puzzle, rotating sudoku → word scramble → crossword. Each has **Skip this puzzle**. Skipping a question gives no puzzle.
- Menu → **Play a puzzle** any time. Menu → **Puzzles during guided setup** turns the rewards off.
- Word lists and crossword grids are in `docs/puzzles.js` (`SCRAMBLE_WORDS`, `CROSSWORDS`) and are easy to add to. `npm test` checks every crossword's words cross correctly.

## Getting it onto the phones (free, no server)

A web app has to be opened from an https address once to be installed. GitHub Pages can hand out the app's files for free. It only serves the files in `docs/`; it never sees any budget data, because the app never sends any.

1. Push this repository to GitHub.
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder: `/docs` → Save**.
3. After a minute the address is `https://<your-github-name>.github.io/ammon-family-values/`.
4. On each phone: open that address in **Chrome** → **⋮ → Install app** (or **Add to Home screen**).

On GitHub's free plan, Pages needs the repository to be **public**. That exposes this code, not your budget. This Pages setup has not been run yet.

To try it on a computer instead: `npx serve docs` (or any static file server) and open the `localhost` address it prints.

## Using it

- **Guided setup** asks for one value per screen, with an **"I'm asking for"** line and an **(i)** button for a longer explanation. The wording is in `HELP` in `docs/model.js`.
- **Big boxes:** type a number and it saves by itself.
- **+ Add spending** / **+ Add money received**: type `12.50` and it is added to the running total. **Subtract** is for refunds and mistakes.
- Tap an item's name to rename or delete it; **+ Add income / + Add expense** adds more.
- Arrows change months. Menu → **Copy last month's planned amounts**; **Guided setup for this month** walks through everything again.
- **App lock (PIN):** Menu → *Turn on app lock*. 4 to 8 numbers, asked when the app opens and after a minute away. Five wrong tries makes you wait 30 seconds. A forgotten PIN cannot be recovered: **I forgot my PIN** deletes the budget from that phone, and a budget file from family brings it back.
- Menu also has **Change the sharing password**, currency, extra-large text, and **Delete this budget from this phone**.

## What was and wasn't verified

- **Verified (automated, `npm test`, 20 checks on the real app code):** saving and reopening; that storage holds no readable labels, amounts or key; that data from the earlier server-based version still opens; that the app's code has no network calls; that every file is in the offline list and every element the code uses exists; locking and opening budget files (wrong password, altered file, wrong kind of file, text re-wrapped by email); a second phone opening a file; newer-wins merging both ways; the both-changed warning; renames, removals and cleared amounts; separately set-up phones lining up by item name; the PIN lock; the sealed sharing password; setup help text; 500 generated sudokus each having exactly one answer; every scramble word; every crossword grid.
- **Verified (headless Chrome at phone size, two separate "phones", 14 checks, `test/browser.mjs`):** setup with all three puzzles solved by tapping, wrong moves showing the warning, skipping, puzzles off; sending a file; the second phone opening it (wrong password and wrong file refused); an update coming back with the preview, Cancel, and Update; pasting the file as text; puzzles from the menu; PIN lock; reload and use with the network off; small-phone dark mode with extra-large text; no sideways overflow on any screen; no console errors; and that the only requests made were for the app's own files.
- **Not verified:** a real Android phone. In particular: installing it, Android's share sheet handing the file to an email app (the test used "Save the file"), opening an attachment from an email app, and the GitHub Pages setup.

## Known limits

- **Newest change wins, per amount.** If you both add spending to the same item between swaps, the later total replaces the earlier one instead of adding them. The preview flags it; fix the total by hand. (The real fix is the first item below.)
- **"Newest" uses each phone's clock.** A phone with a badly wrong clock can win or lose when it shouldn't.
- **The budget file is only as safe as the sharing password.** A short or guessable password can be cracked by someone who gets the file. Capital letters and extra spaces are ignored so two people typing it don't lock each other out.
- **The PIN lock is a casual lock.** A 4 to 8 digit PIN can be guessed by someone who copies the phone's storage. It keeps out someone who picks up an unlocked phone.
- **No automatic backup.** Clearing the browser's site data or uninstalling deletes the budget from that phone. Keep a budget file.
- It is a PWA, not a Play Store APK.

## What to extend first

1. **Make adds combine instead of replace:** store each "add spending" as its own entry and sum them. That removes the main limit above and gives a history.
2. **Test on a real phone.**
3. **Yearly overview and rollover** of leftover money between months.
4. **More puzzles:** bigger word lists, 6 x 6 sudoku, a longer crossword as a "month finished" reward.
5. **Biometric unlock** (WebAuthn) next to the PIN.
6. **Real APK** via Bubblewrap (Trusted Web Activity) once the Pages address exists.

## Layout

```
docs/index.html     screens and dialogs
docs/style.css      warm theme, large touch targets, dark mode
docs/app.js         UI: guided setup, quick add, lock, send / bring in, puzzles
docs/model.js       budget state, money math, setup help text, budget-file merge rules (no DOM)
docs/local.js       sealed storage on the phone
docs/vault.js       key derivation and AES-GCM sealing
docs/share.js       budget files: locking with the sharing password, reading them back
docs/lock.js        PIN lock: wraps the budget key with a PIN-derived key
docs/puzzles.js     sudoku maker, scramble words, crossword grids (no DOM)
docs/games.js       draws the puzzles
docs/sw.js          offline app shell
test/app.test.mjs   automated checks (npm test)
test/browser.mjs    phone-size browser run (needs Playwright and Chrome; optional)
```
