# Changelog

## 2.2.0

Built from captured DOM of a complete Workday flow: sign-in, candidate home, job
posting, and all five apply steps.

### Fixed

- **An email address was written into the phone extension field**, and reached a
  live application's review page. `labelText` blended an explicit `label[for]`
  with text harvested from surrounding elements. On the My Information step the
  Phone Extension field follows the Email Address section, whose address is
  read-only text rather than an input, so the label became "Phone Extension ·
  Email Address someone@example.com" and the email rule matched. An explicit
  label now ends the search, and harvested sibling text containing an "@" or a
  long number is rejected as data rather than treated as a label.
- **The bot trap was fillable.** Workday plants an input named `website`,
  labelled "This input is for robots only, do not enter if you're human". A
  generic matcher hunting for a portfolio URL walks straight into it, and a
  populated trap marks the application as machine-submitted. Traps are now
  detected by name, label wording, off-screen positioning, clip, opacity and
  aria-hidden, and are never filled even during a manual section fill.
- Workday's split date controls (three separate spinbuttons for month, day and
  year) are skipped rather than partially filled, since half a required date is
  worse than none.

### Added

- A compatibility check before every write. A value has to suit the field, so a
  bad guess leaves a field empty instead of putting an email in a salary box.
  Verified against the real values from the captured pages.
- Workday's exact field ids for the My Information step, so name, address, city,
  postal code, country, phone and country code no longer rely on heuristics.
  `#phoneNumber--extension` is deliberately left unmapped.
- Candidate Home import: the applications Workday already lists are read
  straight off the page, with status taken from the portal rather than guessed,
  and added to the tracker in one click.

## 2.1.0

### Changed

- **Scope.** The content script matched every URL and now matches only known
  applicant tracking systems, 39 patterns across 27 systems. Everywhere else it
  is not injected at all. `<all_urls>` moved to an optional permission, requested
  per site only when you choose to add one.
- Relicensed from MIT to Apache-2.0, with a `NOTICE` file.

### Fixed

- **It scored your resume against the apply form.** Whether a page was a job
  posting was decided by counting words like "requirements" in the body text,
  which a wizard step trips easily, so the match card appeared mid-application.
  Page kind is now determined from structure, and inside an apply flow the card
  offers to fill rather than to score.

### Added

- A status marker in the corner of supported pages, always present, reporting
  what JobVault can see: the current Workday step, how many fields are ready, or
  which saved login matched. Click it for the controls. Can be turned off.
- Workday step awareness read from the progress bar rather than guessed, so it
  knows it is on "My Experience, step 2 of 5".
- Per-section filling. Sections on the page are enumerated from their
  `role="group"` headings, and each gets its own Fill button, so a wrong
  automatic guess is never a dead end. Sections needing their Add button pressed
  first say so, and uploads are marked as yours to do.
- One-time and permanent activation for career sites outside the built-in list.

## 2.0.1

Data safety and update reliability. Everything below was found by testing the
2.0.0 code rather than reading it, and each item was a real way to lose data.

### Fixed

- **Concurrent writes clobbered each other.** `mutate()` was a read-modify-write
  with no lock, despite a comment claiming otherwise. Saving a job from a page
  while the dashboard autosaved a profile edit lost one of the two, reproducibly.
  All vault writes now run through a single serialized queue.
- **`fillLogin` and `captureLogin` bypassed that queue** with their own
  read-modify-write, which are exactly the content-script paths that fire while
  the dashboard is open. Both now run inside it.
- **An open dashboard erased background changes.** `saveVault` wrote a whole-vault
  snapshot taken when the page loaded, so any job saved or status changed in the
  meantime was overwritten by an unrelated edit. Replaced by `patchVault`, which
  sends only the edited sections and merges them into a fresh read.
- **The auto-update could discard a pending edit.** The disk watcher called
  `chrome.runtime.reload()` immediately, killing the service worker while the
  dashboard still held a debounced save. A reload now asks open pages to flush,
  waits for the write queue to drain, takes a backup, and retries if still busy.
- **The 1.x migration had a torn write.** New meta, holding a newly generated key,
  and the re-encrypted vault body were written in two separate storage calls. An
  interruption between them left the vault encrypted with a key that existed
  nowhere. Both are now committed in a single write.
- **A failed decrypt could look like an empty vault**, inviting the user to start
  over on top of recoverable data. It now reports the failure and points at the
  backups, and a failed read can never cause a write.

### Added

- Twelve rolling encrypted snapshots kept in the browser: one daily, plus one
  before every update reload, restore, import, master password change and
  re-hardening. Restoring is itself backed up first, so it is undoable.
- A **Your data** panel showing backup age, snapshot count, extension ID and a
  permanent warning that moving the extension folder orphans the vault.
- `scripts/verify.sh`, which checks that the manifest parses, every file it names
  exists and every script compiles. Nothing stamps `build.json` until it passes,
  so a broken commit cannot reach the running browser. `update.sh` rolls back to
  the last working commit, the git hooks skip stamping and say why, and the native
  updater performs the same check in Python.
- The 1.x vault is copied aside untouched during migration and kept. It still
  opens with the master password used at the time.
- Vault revision counter, and a refusal to open a vault written by a newer
  version rather than normalizing away fields this build does not understand.
- Import now names what is in the file and the date it was taken before replacing
  anything, and records when you last exported.

### Changed

- Resume match scoring was badly calibrated: filler vocabulary such as
  "professional", "demonstrated" and "bachelor" was weighted close to named
  skills, so a resume covering every real requirement scored 28%. Named skills now
  carry far more weight, the must-have gap list is restricted to actual skills, and
  the same resume and posting now score 68%.
- `entropyBits` accounts for site rules that narrow the character pool, instead of
  overstating a password the site forced to be weaker.

## 2.0.0

A rewrite. The previous version had three bugs that between them made it not work.

### Fixed

- **Autofill never ran on job portals.** The content script checked for password
  fields exactly once, at `document_idle`, and after that only if the URL string
  changed. Workday, Greenhouse, Lever and iCIMS all render their login form after
  that moment, so the check always found zero fields and the fill was never
  attempted. The fill code itself was fine. Replaced with a debounced
  `MutationObserver`, `history.pushState`/`replaceState` interception,
  `popstate` and `hashchange` listeners, and staged retries at 0.9s, 2.2s, 4.5s
  and 8s.
- **Saved links could not be opened, because nothing saved links.** The vault had
  no concept of a job or an application, only credentials keyed by hostname.
  Added a tracker with URL, company, role, location, salary, closing date and the
  full job description text.
- **Frames matched the wrong host.** The content script ran in every iframe with
  `all_frames: true` and looked up credentials using the iframe's own hostname,
  so an embedded Greenhouse or Lever form searched for the wrong site entirely.
  It also drew a duplicate card in hidden frames. Autofill and UI are now
  restricted to the top frame or a same-origin frame of usable size.
- **Values set by JavaScript were ignored by React.** Assigning to `.value`
  leaves a framework's internal state stale and its validation errors showing.
  Now writes through the prototype's value setter and dispatches the full
  `focus → keydown → beforeinput → input → keyup → change → blur` sequence.
- **Modulo bias in the password generator.** Replaced with rejection sampling
  plus a Fisher-Yates shuffle.

### Security

- Plaintext passwords are no longer pushed to every content script on every page
  load. Page context now returns metadata only; credentials are handed over at
  the moment of the fill, for the acted-on origin.
- PBKDF2 iterations raised from 250,000 to 600,000. Existing vaults record their
  own iteration count and keep opening; Settings offers to re-wrap at the new
  strength.

### Added

- Application tracker: eight statuses, dated event history, follow-up reminders,
  filtering, sorting, search and CSV export.
- Application autofill across roughly forty profile fields, with selector packs
  for Workday, Greenhouse, Lever, Ashby, SmartRecruiters, Workable, iCIMS, Taleo,
  SuccessFactors, BambooHR, Jobvite, Teamtailor, Breezy and Recruitee, and
  generic label-walking for everything else.
- A fill receipt naming every field that was filled and every field that was not.
- Resume matching that weights the requirements section above the body, detects
  years-of-experience and degree requirements, and lists must-have gaps.
- Job capture from schema.org `JobPosting` metadata, falling back to per-portal
  selectors.
- Automatic status change to Applied on detecting a confirmation page.
- A full-page dashboard alongside the popup, so the popup can stay small and
  answer only "what can I do on this page".
- Keyboard shortcuts for open, fill login, fill application and save job.
- Saved answers library for repeated free-text questions.
- Login aliases, for companies that split login and job board across hostnames.
- Reused-password detection across saved employers.
- Self-updating: `build.json` stamping, a disk watcher that reloads the extension
  after a pull, GitHub commit comparison with private-repo token support, git
  hooks so your own commits also trigger a reload, and an optional native
  messaging helper for one-click updates.
- Vault backup and restore.
- Badge and notifications for updates and due follow-ups.

### Changed

- Vault schema is now version 3. Vaults from 1.x are migrated on unlock: `entries`
  becomes `logins`, and a bare email list becomes a full profile.
- `Ctrl+Shift+J` was avoided as a shortcut because Chrome uses it for devtools.

### Known limits

Resume file uploads cannot be automated by any extension. PDF and DOCX are not
parsed. See the README.

## 1.1.0

- Initial release: encrypted credential storage, per-host matching, password
  generation.
