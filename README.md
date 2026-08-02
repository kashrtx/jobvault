# JobVault

A private, on-device password manager and resume matcher built for Workday and other job application sites. No servers, no accounts, no network calls. Everything is encrypted with one master password and stays on your machine.

Built for Brave and Chrome (any Chromium browser, Manifest V3).

## Why this exists

If you have applied to more than a handful of jobs, you know the pain. Every employer runs its own Workday address, like `nvidia.wd5.myworkdayjobs.com` and `disney.wd1.myworkdayjobs.com`. The browser's built in autofill lumps them all together as "myworkday" and confidently hands you the wrong company's login. So you reset a password you already had, again.

JobVault fixes that at the root. It saves each login against the exact site address, so the right company shows up every time and the wrong one never does. Then it goes a step further and helps with the rest of the grind: strong passwords on sign up, and a quick check of your resume against a job post before you sink an hour into the application.

## Features

- **Right login, right company.** Credentials are keyed to the exact hostname, so Workday tenants never cross contaminate.
- **One tap sign up.** Pick which of your emails to use, and JobVault fills it along with a freshly generated strong password, then remembers the login once you finish.
- **Preferred emails.** Keep a short list of the addresses you apply with and set a default. New emails you use get learned automatically.
- **Knows create account from sign in.** It offers a strong password on a new account, and if you already have a login for that company it points you to sign in instead of making a duplicate.
- **Not just Workday.** Reads the page instead of matching a fixed list, so Greenhouse, Lever, iCIMS, Taleo, SuccessFactors, Ashby, and ordinary careers pages all work the same way.
- **Automatic resume match.** With a resume saved, opening a job post shows your match score and the terms worth adding, right on the page. Toggle it off any time.
- **Quick unlock PIN.** Unlock with a short PIN instead of the full master password, with a lockout that falls back to the master password after too many wrong tries.
- **Local and encrypted.** A random data key encrypts the vault and is itself wrapped by your master password and your PIN. Auto locks on a timer you set.
- **Encrypted backups.** Export and import your vault as a file that is useless without your master password.

## Install from source

1. Download or clone this repository.
2. Open `brave://extensions` or `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the repository folder (the one containing `manifest.json`).
5. Pin JobVault from the puzzle icon, click it, and set your master password.

## Using it

- On a **sign up** page, a small card appears in the corner. One tap fills your email and a strong password, and it saves the login after you submit.
- On a **login** page you have used before, it fills in on its own.
- On a **job post**, open the Resume tab and hit **Scan the job on this tab**.
- Manage everything, back up, and change your master password from the popup.

## How it works

Vanilla JavaScript, no build step, no dependencies.

| Piece | Role |
| --- | --- |
| `manifest.json` | Manifest V3 setup and permissions |
| `background.js` | Service worker. Owns the vault, holds the unlocked key in session memory, runs the auto lock timer, and answers the page and popup |
| `content.js` | Detects login and sign up forms, fills known logins, offers passwords, captures new logins, and reads job descriptions |
| `popup.html` / `popup.css` / `popup.js` | The interface: logins, generator, resume match, settings |
| `lib/crypto.js` | AES-GCM and PBKDF2 helpers used by the worker and popup |
| `lib/match.js` | The resume to job keyword matcher, shared by the page and the popup |

The vault is a single encrypted blob in `chrome.storage.local`. A random 256 bit data key encrypts that blob. The data key is then wrapped twice, once by a key derived from your master password and once by a key derived from your PIN, both stretched with PBKDF2 (250k iterations, SHA-256). Unlocking with either one unwraps the data key, which lives in `chrome.storage.session` (memory only, cleared when the browser closes or the auto lock fires) while you work. Changing your master password or PIN only re-wraps the data key, so the vault itself is never re-encrypted and cannot be left half converted. The content script never sees any key. It asks the worker for a decrypted login when it needs one.

## Privacy and security

This is a personal, single user tool with no backend by design. Nothing is transmitted anywhere. That said, be realistic about the threat model. It protects a vault of job site logins on your own machine well. It is not meant to replace a hardened, audited password manager for high value accounts like your bank.

There is no master password reset. That is the cost of being truly local, so store your master password somewhere safe.

## Development

No toolchain required. Edit the files and reload the extension from the extensions page.

Optional sanity check if you have Node installed:

```
npm run check
```

To build a distributable zip:

```
npm run package
```

## Roadmap

- A Workday "apply faster" profile that pre fills name, phone, and work authorization fields.
- Optional TOTP two factor codes stored in the vault.
- Firefox support once the session storage story is sorted.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
