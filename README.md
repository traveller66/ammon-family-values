# Ammon Family Values

A family budget that installs on Android like an app and lives **only on your own phone**. It stores **only numbers** (and the labels you give them): no names, no locations, no accounts. There is no server. To share, one person emails a locked budget file and the other brings it in.

- **What it is:** an installable web app (PWA): plain HTML/CSS/JS in `docs/`, no build step, nothing to `npm install`.
- **What it talks to:** nothing. The app's code contains no network calls. After the first visit it runs with no internet.
- **Fun part:** first-time setup asks for one number at a time, and every answer is followed by a puzzle (sudoku, word scramble, crossword; hard by default, with an Easy mode button on every puzzle) that has to be solved to move on. After that, puzzles are there whenever you want one and never required.

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

## Setup and puzzles

- **First-time setup** asks one small question per screen: each income on its own (Paycheck 1, Paycheck 2, Other income), then each bill on its own (Rent or mortgage, Electricity, Water and gas, Phone and internet, and so on). The starting list is `DEFAULT_CATEGORIES` in `docs/model.js`.
- **The explanation is always on the screen:** an **"I'm asking for"** line (for example "Net income: the first paycheck, after taxes") and a short paragraph saying what to count and what to leave out. The wording is `HELP` in `docs/model.js`.
- **Every answer is followed by a puzzle that must be solved to move on**, rotating sudoku → word scramble → crossword. There is no skip. So nobody gets stuck: **Give me a hint** puts one right answer in place (as many times as needed), **Check my answers** marks wrong squares in red (sudoku and crossword), **Try a different puzzle** swaps it for another one, and **Too hard? Easy mode** swaps it right away for an easy puzzle of the same kind (still required during setup).
- **Easy mode / hard mode:** the Easy mode button on any puzzle (or Menu → **Easy puzzles**) switches every puzzle after it to easy too, until **Back to hard mode** (or the menu switch) turns it off. It is remembered on the phone (`fb.level`). Easy puzzles: a 9 × 9 sudoku with 41 numbers given that only needs the easy moves, one shorter word to unscramble, and a small crossword (up to 8 × 8, about 8 words) with plain clues.
- **Hard puzzles (the default) are big:**
  - **Sudoku:** full 9 × 9, about 23–27 numbers given, exactly one answer, and always needing at least one technique beyond the easy "only number that fits" moves (locked candidates, pairs or triples), but never guessing. **Notes** pencils in small numbers; placing a number clears it from the notes around it. A repeated number shows in red right away.
  - **Word scramble:** three long words or two-word phrases in a row (8–16 letters, like COMPOUND INTEREST or REIMBURSEMENT), with the letters of both words mixed together.
  - **Crossword:** a fresh grid every time, about 17–23 interlocking words on a grid up to 13 tall and 11 wide, with trickier clues. Full keyboard, a clue bar with ‹ › to move between clues, tap a square twice to switch across/down, tap any clue to jump to it. A hardware keyboard works too.
- A question left blank (**Skip for now**) has no puzzle. **We don't have this one** removes the item from the budget.
- Closing the app part-way through picks setup up again at the next unanswered question.
- **After first-time setup, puzzles are never required.** **Play a puzzle** is on the main screen and in the menu. If you run **Guided setup for this month** again, its puzzles can be skipped, and Menu → **Puzzles when I redo guided setup** turns them off.
- A phone that got its budget from a budget file never goes through first-time setup, so it is never required to play.
- Word lists are in `docs/puzzles.js` (`SCRAMBLE_WORDS` / `SCRAMBLE_EASY`, and `CROSSWORD_WORDS` / `CROSSWORD_EASY` for the crossword's words and clues) and are easy to add to: crossword grids are built from that list automatically. `npm test` checks that clues never give away their answers and that 150 freshly built grids fit a phone, link up, and form no stray words.

## Getting it onto the phones (free, no server)

A web app has to be opened from an https address once to be installed. GitHub Pages can hand out the app's files for free. It only serves the files in `docs/`; it never sees any budget data, because the app never sends any.

1. Push this repository to GitHub.
2. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: `main`, folder: `/docs` → Save**.
3. After a minute the address is `https://<your-github-name>.github.io/ammon-family-values/`.
4. On each phone: open that address in **Chrome** → **Install the app** (or **⋮ → Install app**).

**The address only installs the app.** Opened in a browser tab it shows an install page and nothing else; the budget opens only from the installed app's icon. This keeps the budget out of ordinary browser tabs (on your own phone, a tab shares storage with the installed app). It is a convenience, not a lock: the app's files are public, anyone can install their own empty copy, and what protects your numbers is that they are stored only on your phone, plus the PIN. If the home-screen icon ever shows the install page, it was added as a plain shortcut: remove it and use **Install app**.

On GitHub's free plan, Pages needs the repository to be **public**. That exposes this code, not your budget. This Pages setup has not been run yet.

To try it on a computer instead: `npx serve docs` (or any static file server), open the `localhost` address it prints in Chrome, and install it from the address bar. A plain tab shows only the install page.

## Using it

- **Big boxes:** type a number and it saves by itself.
- **(i)** on every item explains what belongs in it (net or gross, which bills) and what its two boxes mean.
- **+ Add spending** / **+ Add money received**: type `12.50` and it is added to the running total. **Subtract** is for refunds and mistakes.
- Tap an item's name to rename or delete it; **+ Add income / + Add expense** adds more.
- Arrows change months. Menu → **Copy last month's planned amounts**; **Guided setup for this month** walks through everything again.
- **App lock (PIN):** Menu → *Turn on app lock*. 4 to 8 numbers, asked when the app opens and after a minute away. Five wrong tries makes you wait 30 seconds. A forgotten PIN cannot be recovered: **I forgot my PIN** deletes the budget from that phone, and a budget file from family brings it back.
- Menu also has **Change the sharing password**, currency, extra-large text, and **Delete this budget from this phone**.

## What was and wasn't verified

- **Verified (automated, `npm test`, 21 checks on the real app code):** saving and reopening; that storage holds no readable labels, amounts or key; that data from the earlier server-based version still opens; that the app's code has no network calls; that every file is in the offline list and every element the code uses exists; locking and opening budget files (wrong password, altered file, wrong kind of file, text re-wrapped by email); a second phone opening a file; newer-wins merging both ways; the both-changed warning; renames, removals and cleared amounts; separately set-up phones lining up by item name; the PIN lock; the sealed sharing password; setup help text; 80 generated 9 × 9 sudokus each having exactly one answer (checked by a separate solver) and being solvable by reasoning but not too easy; every scramble word and round; 150 generated crossword grids; and the same for easy mode (60 easy sudokus finished by the easy moves alone, every easy word, 150 small grids).
- **Verified (headless Chrome at phone size, two separate "phones", 19 checks, `test/browser.mjs`):** a browser tab getting only the install page, including on a phone that already has a budget; first-time setup one question at a time with the explanation showing on every question; all three puzzles solved by tapping (sudoku notes included), wrong moves showing the warning, the crossword's Check marking a wrong letter, no skip offered, hints and "a different puzzle" finishing a puzzle; Easy mode swapping a required puzzle for an easy one of the same kind, being remembered, and matching the menu switch; "We don't have this one"; setup resuming after the app is closed part-way; puzzles skippable and switchable once setup is done; the (i) on main-screen items; sending a file; the second phone opening it (wrong password and wrong file refused); an update coming back with the preview, Cancel, and Update; pasting the file as text; puzzles from the menu; PIN lock; reload and use with the network off; small-phone dark mode with extra-large text; no sideways overflow on any screen; no console errors; and that the only requests made were for the app's own files.
- **Not verified:** a real Android phone. In particular: installing it, the installed app being recognised as installed (the browser run simulates that answer), Android's share sheet handing the file to an email app (the test used "Save the file"), opening an attachment from an email app, and the GitHub Pages setup.

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
4. **More puzzles:** bigger word lists, a timer and best times.
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
docs/puzzles.js     sudoku maker and grader, scramble words, crossword words and grid builder (no DOM)
docs/games.js       draws the puzzles
docs/sw.js          offline app shell
test/app.test.mjs   automated checks (npm test)
test/browser.mjs    phone-size browser run (needs Playwright and Chrome; optional)
```
