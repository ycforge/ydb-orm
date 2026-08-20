# Examples index

This folder contains practical examples showing how to use ydb-orm in common scenarios:

- outbox/ — outbox pattern example (transactional event staging + dispatcher)
- migrations/ — CI examples for running migrations
- kms/ — examples and guidance for KMS-backed encryption

How to run
1. Install dependencies (root of repository):
   npm ci
2. Build or run examples with ts-node (you may need to point imports to built src):
   npx ts-node ./examples/outbox/service.ts

Notes
- Examples are illustrative; adapt to your runtime, executor and deployment.
- If you want, I can add a GitHub Actions workflow file that runs a minimal example in CI or create demo scripts.
