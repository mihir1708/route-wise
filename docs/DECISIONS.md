# Architecture decisions

1. **Retain Next.js/Supabase.** Existing module boundaries are sufficient; no
   service rewrite is needed. Pages Router remains supported by the installed app.
2. **PostgreSQL atomic increments.** ON CONFLICT initialization and row-locked
   updates solve lost updates without Redis. Six-decimal spend and existing limits
   survive migrations. Transactions include normalized model/tier counters.
3. **Separate lifecycle outcomes.** A provider success is not proof of successful
   bookkeeping. Preserve usage/answer after non-critical failures; keep unknown
   usage null. No unsafe automatic retry or fabricated free request.
4. **One registry, historical identities immutable.** Explicit versioned runtime
   config replaces scattered model assumptions. Legacy IDs/prices stay available
   to baseline tests and remain untouched in historical rows.
5. **Versioned deterministic routing.** v1 remains the reference implementation.
   v2 requires evidence and explicit feature configuration, never becomes default
   based only on intuition. Learned training waits for reviewed labels.
6. **Deterministic scoring before model judging.** Use exact/field/schema/property
   checks whenever possible. Rubric judges are opt-in, versioned, validated and
   subject to human calibration. Untrusted code is not executed without isolation.
7. **Minimal demo auth.** Server-side Basic credentials over HTTPS, roles, origin
   checks and per-instance rate buckets fit the portfolio scope. Production user
   management/distributed quotas remain a separate design decision.
8. **Database-backed verification jobs.** Serverless lifetime is not a reliable
   background executor. A separate worker uses atomic claims. No Redis/Kafka.
   Unknown worker outcomes are not automatically replayed, preventing hidden costs.
9. **Data minimization.** Production telemetry omits raw prompt/response. Explicit
   verification consent permits temporary payload storage, cleared by scheduled
   maintenance. Evaluation artifacts are separate controlled local files.
10. **Evidence boundaries.** Dry runs have no performance metrics. Unit fixtures
    are not benchmarks. Human-review flags require human provenance; reports
    expose missing coverage and unknown cost instead of filling them with zeros.
