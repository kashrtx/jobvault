# Contributing

Thanks for taking a look. This is a small, dependency free extension, so getting started is quick.

## Setup

1. Clone the repo.
2. Load it as an unpacked extension from `brave://extensions` or `chrome://extensions` with Developer mode on.
3. Make a change, then hit the reload icon on the extension card to see it.

## Ground rules

- No build step and no runtime dependencies. Keep it vanilla so anyone can read and audit it.
- Nothing should ever leave the machine. No analytics, no remote calls, no telemetry.
- Run `npm run check` before opening a pull request.

## Good first areas

- Better form detection on tricky single page application sign in flows.
- More site specific company name guesses.
- Improvements to the resume keyword matcher.

## Reporting issues

Open an issue with the site you were on (the general one, not anything private), what you expected, and what happened. Please do not include real passwords or personal details.
