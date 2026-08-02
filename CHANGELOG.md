# Changelog

All notable changes to this project are documented here.

## [1.1.0] - 2026-08-02

- Quick unlock PIN. Set a 4 to 12 digit PIN to unlock without typing the master password, with a lockout after five wrong tries that falls back to the master password.
- Reworked the encryption so a random data key holds the vault and is wrapped separately by the master password and the PIN. Changing either one now re-wraps that key instead of re-encrypting the whole vault, which removes a class of corruption bugs.
- Preferred emails. Keep a list of the emails you apply with, pick a default, and choose which one to use right from the sign up card.
- Automatic resume match. If a resume is saved, opening a job post shows your match score and the terms worth adding, no clicking required. Can be turned off in Settings.
- Smarter page detection. Tells apart create account and sign in screens, and if you already have a login for a company it points you to sign in instead of making a duplicate.
- Fixed the dialog that could cover the screen on first launch.

## [1.0.0] - 2026-08-02

First release.

- Local, encrypted vault with a master password (AES-GCM, PBKDF2).
- Logins keyed to the exact hostname so Workday tenants never mix up.
- Autofill for known logins and one tap email plus strong password on sign up.
- Works across Workday, Greenhouse, Lever, iCIMS, Taleo, SuccessFactors, Ashby, and generic careers pages.
- Password generator with adjustable length, character sets, and a strength meter.
- Resume to job matcher with a score and matched or missing keywords.
- Settings for default email, autofill toggle, and auto lock timer.
- Encrypted export and import.
