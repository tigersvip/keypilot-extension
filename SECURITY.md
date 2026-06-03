# Security Policy

KeyPilot handles sensitive browser data such as credentials, generated passwords, and structured form-fill profiles. Please treat security reports carefully.

## Supported Versions

The project is currently in Beta / Preview. Only the latest `main` branch is expected to receive security fixes during early development.

## Reporting a Vulnerability

Please do not open a public issue with exploit details.

Preferred report contents:

- A short vulnerability summary.
- Affected browser and operating system.
- Steps to reproduce.
- Whether real credentials or private user data can be exposed.
- Suggested fix, if known.

Until a private security contact is published, please create a minimal public issue that says you have a security report, without exploit details. A maintainer can then arrange a private channel.

## Security Model

- KeyPilot is local-first.
- Vault data is encrypted before being stored in browser extension storage.
- The master password is not persisted.
- The extension should not upload saved domains, credentials, or fill-profile data to third-party services.
- Favicon loading must not use third-party logo APIs.

## Out of Scope

- Issues caused by installing modified builds from untrusted sources.
- Browser or operating-system vulnerabilities unrelated to KeyPilot.
- Physical access to an already unlocked device.
- Social engineering attacks.

## Important Disclaimer

This project has not yet completed an independent security audit. Do not market it as audited or production-hardened until that work is complete.

