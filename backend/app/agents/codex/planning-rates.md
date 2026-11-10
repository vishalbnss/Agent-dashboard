# API-equivalent planning rates

Use this table only for a separately labeled planning scenario. It is not evidence of the user's Business, Enterprise, subscription, credit, or provider-billed charge.

Rates were re-verified from official OpenAI model pages on 2026-09-18 and are USD per 1 million text tokens.

| Effective model | Uncached input | Cached input | Output |
| --- | ---: | ---: | ---: |
| `gpt-5.6-sol` | $4.00 | $0.40 | $20.00 |
| `gpt-5.6-terra` | $2.00 | $0.20 | $12.00 |
| `gpt-5.6-luna` | $0.20 | $0.02 | $1.20 |

Official sources:

- https://developers.openai.com/api/docs/models/gpt-5.6-sol
- https://developers.openai.com/api/docs/models/gpt-5.6-terra
- https://developers.openai.com/api/docs/models/gpt-5.6-luna

Formula per invocation or compatible aggregate:

```text
estimate =
  uncached_input / 1,000,000 × uncached_input_rate
  + cached_input / 1,000,000 × cached_input_rate
  + cache_write_input / 1,000,000 × cache_write_rate
  + output / 1,000,000 × output_rate
```

Reasoning tokens are an output subset when reported that way and must not be counted twice. GPT-5.6 cache writes are documented at 1.25× the uncached-input rate. The model pages also document higher rates for requests over 272K input tokens. Fast/Priority, Batch/Flex, tools, modalities, regional pricing, and promotional conditions may differ.

The current Sol promotional rate is documented as available at least through 2026-11-21. Verify all three official model pages before using this table after that date or whenever the run's service tier, context category, or pricing date differs. If required per-request modifiers cannot be established, calculate only the standard short-context scenario and label it `API-equivalent planning estimate`; actual cost remains `Unavailable` unless provider billing supplies it.
