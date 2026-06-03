# Contributing to KeyPilot

Thanks for helping improve KeyPilot.

## Development Setup

```bash
npm install
npm run build
```

Load the generated `dist/` folder in Chrome or Edge extension developer mode.

## Before Opening a Pull Request

- Run `npm run build`.
- Keep changes focused and easy to review.
- Do not commit real credentials, CSV exports, Excel files, `.kpfill` files, Vault backups, or private keys.
- Prefer existing project patterns before adding new abstractions.
- For UI changes, keep layouts compact, accessible, keyboard friendly, and reduced-motion friendly.
- For autofill changes, include the test site or page structure that motivated the change.

## Useful Areas for Contributions

- Website compatibility rules.
- Autofill and one-click-login reliability.
- Identity / fill-profile field matching.
- Accessibility fixes.
- Documentation and screenshots.
- Unit tests and browser-flow tests.
- Security review.

## Bug Reports

Please include:

- Browser and version.
- Extension version or commit.
- Website URL, if public.
- What you expected to happen.
- What actually happened.
- Whether the issue occurs in the built-in test lab.

Do not include real passwords, private CSV files, or sensitive identity data.

