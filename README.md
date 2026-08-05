# JobVault

A password manager and application tracker for job hunting, for Chrome and Brave.

Job portals are a bad fit for ordinary password managers. Every employer runs its
own tenant of the same three or four systems, so you end up with forty accounts
on hostnames like `nvidia.wd5.myworkdayjobs.com` and
`stripe.wd1.myworkdayjobs.com`, all of which look identical to your browser and
none of which remember you. Then each one makes you retype your address, your
work history and your graduation date into a form that was clearly never tested.

JobVault handles the accounts, fills the forms, and keeps track of what you
applied to and when.

---

## What it does

**Logins, per tenant.** Credentials are matched on the exact hostname, with
optional aliases when a company splits its login and its job board across two
domains. A password saved for one Workday tenant is never offered to another,
which is the entire point and the thing generic managers get wrong.

**Autofill that survives single-page apps.** Workday, Greenhouse, Lever, Ashby,
SmartRecruiters, Workable, iCIMS, Taleo, SuccessFactors and BambooHR render their
forms well after the page reports itself loaded. JobVault watches the DOM and
fills when the fields actually appear, not once at load and never again.

**A fill receipt.** After every fill you get a list of exactly which fields were
written and which ones you still need to do by hand. When something cannot be
filled it says so, rather than quietly doing nothing.

**Application tracking.** Save a posting with `Alt+Shift+S` and you get the
company, role, location, salary, closing date and the full text of the job
description, kept in your vault so it survives the posting being taken down.
Eight statuses, dated history, and follow-up reminders when an application has
gone quiet. Every saved job has a working link.

**Resume matching.** Paste your resume once. JobVault scores a posting against
it, separating things listed under requirements from things mentioned in passing,
and tells you what is missing before you spend forty minutes on the form.

**Saved answers.** The "why do you want to work here" library, so you are not
rewriting it at midnight.

---

## Install

JobVault is not on the Chrome Web Store. It runs as an unpacked extension, which
is also what makes the self-updating work.

```bash
git clone https://github.com/kashrtx/jobvault.git
cd jobvault
./scripts/install-hooks.sh
```

Then in Chrome or Brave:

1. Open `chrome://extensions` (Brave: `brave://extensions`).
2. Turn on **Developer mode**, top right.
3. Click **Load unpacked** and choose the `jobvault` folder.
4. Pin JobVault to your toolbar.
5. Click it and set a master password.

Requires Chrome or Brave 116 or newer. On Windows use
`powershell -ExecutionPolicy Bypass -File scripts\update.ps1` in place of the
shell scripts.

> **Pick the folder's permanent home before you load it.**
>
> Chrome identifies an unpacked extension by its folder path, and your vault is
> stored against that identity. Moving or renaming the folder later makes the
> browser treat it as a different extension, and the vault stops appearing. It is
> not deleted, and moving the folder back restores it, but it is a bad surprise.
>
> The practical rule: **upgrade by changing the files inside this folder**, with
> `git pull`, and never by loading a second copy from somewhere else. Settings
> shows this warning permanently, along with your extension ID.

### First five minutes

Open the dashboard and fill in the **Profile** panel. Autofill has nothing to
type without it, and the fields there are the ones portals ask for over and over.
Then paste your resume into **Resume**. Both are one-time jobs.

Then use **Settings → Export encrypted backup** once. It takes a second and it is
the only copy that survives uninstalling the extension.

### Upgrading from version 1.x

Unlock once with your existing master password and the vault upgrades itself:
logins, saved emails and settings all carry over. Before it writes anything it
copies your 1.x vault aside, untouched, and keeps it. If you ever need it, it
still opens with the master password you used then. The new meta and the new
vault body are written in a single storage operation, so there is no moment where
an interrupted upgrade could strand the vault under a key that no longer exists.

---

## Keyboard shortcuts

| Shortcut | Does |
| --- | --- |
| `Ctrl+Shift+Y` | Open JobVault |
| `Ctrl+Shift+L` | Fill the login on this page |
| `Alt+Shift+F` | Fill this application form |
| `Alt+Shift+S` | Save this job posting |

On macOS, `Ctrl` is `Command`. Change them at `chrome://extensions/shortcuts`.

---

## Staying up to date

An extension cannot rewrite its own files, so updating means moving the git
checkout. JobVault makes that as close to automatic as the browser allows, and it
is built to refuse a bad update rather than apply one.

**Pull, and you are done.**

```bash
./scripts/update.sh
```

That fast-forwards the branch, checks the result, and rewrites `build.json` with
the new commit. The service worker re-reads `build.json` from disk once a minute,
and because Chrome serves unpacked extension files straight from the folder, the
still-running old code can see that the folder underneath it has changed. It then
reloads itself. Your vault is untouched; it lives in `chrome.storage.local`, not
in the folder.

**Nothing broken gets applied.** `scripts/verify.sh` checks that the manifest
parses, that every file it names exists, and that every script compiles. Stamping
`build.json` is what triggers the reload, so nothing is stamped until that check
passes. If a pulled commit fails it, `update.sh` resets to the commit you were
already running and tells you so, and your browser carries on with the version
that worked. The native updater does the same check, in Python, so Windows
behaves identically.

**The reload waits for you.** Reloading kills the service worker and every open
page instantly, which would discard a dashboard edit still sitting in its
autosave debounce. So the reload is a request, not an order: open pages are asked
to write out pending edits, the write queue is allowed to drain, a backup is
taken, and only then does it reload. If a save is still in flight it backs off
and tries again shortly.

**Your own commits count too.** `install-hooks.sh` adds `post-commit`,
`post-merge`, `post-checkout` and `post-rewrite` hooks that verify and then
restamp. So if you are editing JobVault yourself, committing is enough to make
the browser pick up your changes, and a commit that does not compile is skipped
with a message rather than pushed into the running browser.

**Checking without pulling.** The dashboard compares your commit against GitHub
and shows what is waiting, including commit messages. If the repo is private,
paste a fine-grained personal access token with read-only Contents access into
Settings. Both the check and the auto-reload can be switched off; with auto-reload
off, JobVault tells you an update is ready on disk and waits for you to click.

**One-click updating, optionally.** If you want the **Update now** button to run
the pull itself:

```bash
./scripts/install-updater.sh <your-extension-id>
```

The id is shown in Settings. This installs a small Python native messaging host
that runs `git fetch` and a fast-forward inside the checkout and nothing else. It
is entirely optional; `./scripts/update.sh` does the same job.

---

## Your data

The vault lives in `chrome.storage.local`, encrypted. Nothing in the git folder
contains your data, so pulling, resetting and switching branches are all safe.

**Automatic backups.** Twelve rolling snapshots are kept inside the browser: one
a day, plus one before anything irreversible. That means before an update reload,
before a restore, before an import, before a master password change, and before
re-wrapping the vault at a higher iteration count. Restoring is itself backed up
first, so restoring the wrong one is undoable. They are in **Settings → Automatic
backups**, listed with what each one contains.

**Exported backups.** Snapshots share a fate with the browser profile: they
survive a bad update, but not uninstalling the extension or losing the machine.
The exported file is the real backup. Settings shows how long it has been since
your last one and marks it when that gets stale.

**Concurrent edits do not overwrite each other.** Every write goes through a
single queue, and the dashboard sends only the sections you actually edited,
merged into a fresh read. Saving a job from a page while the dashboard autosaves
a profile edit keeps both.

**A vault that cannot be read says so.** If decryption fails, JobVault reports it
and points you at the backups rather than presenting an empty vault, because an
empty-looking vault invites starting over on top of recoverable data. A failed
read never causes a write. A vault written by a newer version of JobVault refuses
to open on an older one instead of being quietly stripped down to the fields the
older code understands.

**If you forget your master password the vault cannot be recovered.** There is no
reset, because there is nobody holding a copy. The snapshots are encrypted with
the same key, so they do not help. Export a backup and keep it somewhere safe.

---

## Network access

Earlier versions of this README said JobVault makes no network calls. That is no
longer true, and it is worth being precise about what changed.

JobVault makes exactly one kind of outbound request: to `api.github.com`, to ask
whether a newer commit exists. It sends the repository name and, if you supplied
one, your access token. It sends nothing else. Not your vault, not your profile,
not the sites you visit, not usage data. There is no analytics, no telemetry and
no server belonging to this project.

Turn it off in **Settings → Updates → Check GitHub automatically** and JobVault
makes no network requests at all. The disk watcher keeps working, because reading
a file out of the extension's own folder is not a network call.

---

## Security

Your vault is encrypted with AES-256-GCM. The key is derived from your master
password with PBKDF2-SHA-256 at 600,000 iterations and never leaves memory;
it is held in `chrome.storage.session`, which browsers do not write to disk.
Vaults created by older versions record their own iteration count so they keep
opening, and Settings offers to re-wrap them at the current strength.

The vault locks on a timer, default fifteen minutes. The optional PIN is a
convenience over an already-unlocked session, not a second way in to an
encrypted vault, and it locks itself out after five wrong tries.

Content scripts are given credentials only for the origin being acted on, at the
moment of the fill, and only in the top frame or a same-origin frame. Passwords
are not broadcast to pages ahead of time.

Recovery, backups and what happens if the vault cannot be read are covered under
[Your data](#your-data) above.

---

## Honest limits

- **Resume file uploads cannot be automated.** Browsers do not let extensions put
  a file into a file input, for good reasons. JobVault fills everything else and
  tells you the upload is yours to do.
- **PDF and DOCX resumes are not parsed.** Paste the text, or load a `.txt` or
  `.md` file. Shipping a PDF parser to guess at your layout would be worse than
  asking.
- **Workday's custom dropdowns are slow.** If one had not loaded its options
  when the fill ran, it gets listed on the receipt as needing a second pass.
- **New or unusual portals** fall back to generic label matching. It works more
  often than not. When it misses, the receipt tells you which fields it skipped.
- **Match scores are keyword overlap**, not judgement. Treat a low score as a
  prompt to reread the posting, not as a verdict.

---

## If something has gone wrong

**The vault is suddenly empty, or JobVault asks me to create one.** Almost always
the extension folder moved, so the browser sees a new extension with its own empty
storage. Move the folder back to where it was and reload. If that is not possible,
load the folder wherever it now lives and import your exported backup.

**It says the vault could not be read.** Do not create a new vault; that writes
over recoverable data. Open **Settings → Automatic backups** and restore the most
recent one. If Settings will not open, import an exported backup file instead.

**It says the vault was written by a newer version.** You are running older code
than the vault was saved with, usually after checking out an older commit. Run
`./scripts/update.sh` to come forward again. Nothing is damaged; the older code
declines to touch it precisely so nothing is lost.

**An update left the extension unable to load.** `chrome://extensions` will show
the error. Run `./scripts/verify.sh` to see what is wrong, then
`git reset --hard origin/main && ./scripts/stamp.sh` to get back to a known state.
Your vault is untouched by any of this.

**I just imported the wrong backup.** The vault it replaced was snapshotted first.
Unlock and go to **Settings → Automatic backups**; it is the newest entry, labelled
as taken before importing.

**I changed my master password and cannot get in.** Restore the snapshot labelled
as taken before the password change, and unlock with the old password.

---

## Layout

```
manifest.json         MV3 manifest
background.js         service worker: vault, crypto, tracker, alarms, updates
content.js            field detection and the fill engine
popup.html/.css/.js   toolbar popup, scoped to the current page
dashboard.html/...    tracker, profile, resume, answers, settings, backups
lib/crypto.js         key derivation, encryption, password generation
lib/profile.js        the autofill field schema
lib/match.js          resume and posting comparison
lib/update.js         GitHub comparison and build.json reading
scripts/stamp.sh      records the checked-out commit in build.json
scripts/verify.sh     refuses to stamp a tree that would not load
scripts/update.sh     pull, verify, stamp, roll back if needed
scripts/install-hooks.sh    make your own commits reload the extension
scripts/install-updater.sh  optional one-click updating
native/               optional git updater host
```

## Licence

MIT. See `LICENSE`.
