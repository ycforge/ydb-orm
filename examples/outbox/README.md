# Outbox pattern example

This example demonstrates the outbox pattern using ydb-orm. It shows how to write a domain change and an outbox row in a single transaction, then run a dispatcher that reads unsent outbox rows and delivers events.

Structure
- OrderEntity — domain entity (example)
- OutboxEntity — outbox table that stores pending events
- service.ts — example service showing transactionally inserting both
- dispatcher (in service.ts) — reads, sends (simulated) and marks as sent

Notes
- This is an educational example. Adjust to your project's transaction API and executor.
- The important part: write both domain change and outbox row inside the same DB transaction so external systems never see the event without the data.
