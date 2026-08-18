# Repository instructions

- Treat this as an evidence-first system-design practice, not a production social network.
- Keep durable post acceptance, fanout completion, feed response, screen display, and engagement as separate facts.
- Preserve the immutable closed-book contract; record later corrections in the research log or an ADR.
- Do not log bearer tokens, user IDs, idempotency keys, cursor contents, or post text.
- Run `npm run check:ci` against PostgreSQL 17.6 before publishing implementation claims.
- Do not add real user data, production credentials, copied third-party prose, or unlicensed images.
