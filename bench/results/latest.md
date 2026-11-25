Run 2026-11-25 against 200 packages (100 bad, 100 good).

| | Bad names blocked | Bad names blocked or warned | Good names blocked (false positive) | Good names warned |
|---|---|---|---|---|
| **pkgsentry** | **100.0%** | 100.0% | **0.0%** | 2.0% |
| without OSV.dev | 100.0% | 100.0% | 0.0% | 2.0% |

| Category | Ecosystem | n | BLOCK | WARN | ALLOW |
|---|---|---|---|---|---|
| hallucinated (bad) | npm | 25 | 25 | 0 | 0 |
| hallucinated (bad) | pypi | 25 | 25 | 0 | 0 |
| hallucinated (bad) | all | 50 | 50 | 0 | 0 |
| typosquat (bad) | npm | 25 | 25 | 0 | 0 |
| typosquat (bad) | pypi | 25 | 25 | 0 | 0 |
| typosquat (bad) | all | 50 | 50 | 0 | 0 |
| popular (good) | npm | 25 | 0 | 0 | 25 |
| popular (good) | pypi | 25 | 0 | 0 | 25 |
| popular (good) | all | 50 | 0 | 0 | 50 |
| long-tail (good) | npm | 25 | 0 | 1 | 24 |
| long-tail (good) | pypi | 25 | 0 | 1 | 24 |
| long-tail (good) | all | 50 | 0 | 2 | 48 |

Latency per package: cold p50 335ms / p95 1204ms, cached p50 10ms / p95 15ms.

<details><summary>Every miss and false positive</summary>

| Package | Label | Verdict | Signals |
|---|---|---|---|
| `npm:falafel` | long-tail | WARN | repository_missing |
| `pypi:matrx-ai` | long-tail | WARN | repository_missing |

</details>
