# Security policy

## Supported version

Only the current default branch is maintained. This is a bounded educational reference, not a hosted service.

## Reporting

Please report a suspected vulnerability privately through GitHub's security-advisory flow. Do not include real credentials,
personal data, production database contents, or exploit traffic against systems you do not own.

## Deployment warning

The included bearer-token map, plaintext post storage, development Compose credential, and single shared cursor secret are test
fixtures. They are not a production identity, secret-management, encryption, moderation, privacy, abuse-prevention, backup, or
incident-response design. Review [the threat model](docs/threat-model.md) before reusing any code.
