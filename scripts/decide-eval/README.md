# Decide × Laya evaluation kit

[Laya](https://github.com/NandhaKishorM/laya) (Apache-2.0) answers the same
typed questions as `typesafe/jev` — `choice` / `score` / `noul` — with the
same response shape. Its parser was checked against our wire format directly
(`laya/common.py` even documents our exact noul criteria form), so the
payloads here run on it **unmodified**.

Why this matters: if Laya holds up on our real request shape, the follow-up is
an ONNX export of `laya-multilingual` (322M, single forward pass — same size
class as the embeddinggemma we already mirror), which would make the "online"
scorer fully **on-device**: no worker call, no cache, no gate, no network.

## Files

- `gen-payloads.ts` — builds `payloads.json` from the PRODUCTION engine code
  (`buildRequest`, `rankLocal`, `aliasMap`), so the eval exercises exactly what
  the deployed app sends. 12 scenarios across all four domains, including the
  adversarial ones (untagged items, fried-fatigue, wedding).
- `payloads.json` — the generated set. No Khmer, no user data — synthetic
  items with English legends for reading the report.
- `run_laya.py` — feeds the payloads to Laya and applies the SAME gate the app
  applies to Jev (lift ≥ 1.4, self-trust ≥ 1.2/n), reporting per scenario:
  Laya's pick, probabilities, confidence, lift, gate verdict, latency, and
  agreement with the on-device scorer.

## Run it (Colab or any machine with internet)

```bash
pip install laya
python run_laya.py                      # router picks the checkpoint
python run_laya.py --model english      # force a checkpoint
```

CPU is fine (~200–500 ms per scenario). First run downloads ~1.3 GB of
weights from Hugging Face.

## Reading the result

- **gate would USE n/12** — how often the app would have shown "checked
  online" if Laya were the backend. Compare with your Jev experience.
- **Disagreement rows** are the decision: for each, ask which pick you would
  actually have wanted today. Benchmarks don't answer that; you do.
- `M5-untagged` is the honesty probe: with nothing to go on, a well-calibrated
  model should be near-uniform (gate: flat), not confidently wrong.
- `M6-coin-toss` has a ground truth: option B (A was eaten yesterday).

## Regenerating payloads after engine changes

```bash
npx esbuild scripts/decide-eval/gen-payloads.ts --bundle --platform=node \
  --format=esm --outfile=node_modules/.cache/gen-payloads.mjs
node node_modules/.cache/gen-payloads.mjs > scripts/decide-eval/payloads.json
```
