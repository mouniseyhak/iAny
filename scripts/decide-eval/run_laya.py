#!/usr/bin/env python3
"""Run the iAny Decide evaluation set through Laya (open-source Jev-alike).

The payloads are the EXACT wire format the deployed /decide app sends to
typesafe/jev — same English enum sentences, same opt_N aliases, same three
questions — generated from the production code by gen-payloads.ts. This script
feeds them to Laya and judges each answer with the same gate the app applies
to Jev (lift >= 1.4 over uniform, self-trust >= 1.2/n), so the report answers
one question: would Laya's answers have been USED, and do they agree with the
on-device scorer?

Run anywhere with internet (Colab: Runtime > Run all):
    pip install laya
    python run_laya.py [--model english|multilingual|typed-decisions|router]

Needs no GPU — CPU takes ~200-500 ms per scenario.
"""
import argparse
import json
import pathlib
import time

MIN_LIFT = 1.4          # keep in sync with src/decide/jev.ts
MIN_SELF_TRUST = 1.2    # confidence floor = MIN_SELF_TRUST / options


def gate(confidence: float, top: float, n: int) -> str:
    if n < 2:
        return "solo"
    if confidence < MIN_SELF_TRUST / n:
        return "self-doubt"
    if top * n < MIN_LIFT:
        return "flat"
    return "ok"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="router",
                    choices=["router", "english", "multilingual", "typed-decisions"])
    ap.add_argument("--payloads", default=str(pathlib.Path(__file__).parent / "payloads.json"))
    ap.add_argument("--out", default="laya_results.json")
    args = ap.parse_args()

    data = json.load(open(args.payloads))
    scenarios = data["scenarios"]

    from laya import Router  # noqa: import after argparse so --help works offline
    router = Router(preload=False)

    results, used, agreed = [], 0, 0
    for sc in scenarios:
        req = sc["request"]
        t0 = time.perf_counter()
        if args.model == "router":
            res = router.predict(req["state"], req["questions"])
        else:
            res = router.predict(req["state"], req["questions"], model=args.model)
        ms = (time.perf_counter() - t0) * 1000

        pick = res["answers"]["pick"]
        probs = pick.get("probabilities", {})
        ranked = sorted(probs.items(), key=lambda kv: -kv[1])
        top_alias, top_p = ranked[0]
        conf = float(pick.get("confidence", 0))
        n = sc["options"]
        verdict = gate(conf, top_p, n)
        if verdict == "ok":
            used += 1

        dev_top = sc["device"][0]["alias"]
        same = top_alias == dev_top
        if same:
            agreed += 1

        effort = res["answers"].get("effort", {})
        variety = res["answers"].get("needs_variety", {})

        results.append({
            "id": sc["id"], "laya_top": top_alias, "device_top": dev_top,
            "agree": same, "top_p": top_p, "confidence": conf,
            "lift": round(top_p * n, 2), "gate": verdict, "ms": round(ms, 1),
            "effort": effort.get("score"), "needs_variety": variety.get("noul"),
            "probabilities": probs,
        })

        mark = "=" if same else "≠"
        print(f"\n── {sc['id']} · {sc['title']}")
        print(f"   expectation : {sc['expectation']}")
        print(f"   Laya  → {sc['legend'].get(top_alias, top_alias):32s} p={top_p:.2f} conf={conf:.2f} "
              f"lift={top_p * n:.2f} gate={verdict} ({ms:.0f} ms)")
        print(f"   device{mark} {sc['legend'].get(dev_top, dev_top):32s} score={sc['device'][0]['score']:.2f}")
        for alias, p in ranked[1:4]:
            print(f"           {sc['legend'].get(alias, alias):32s} p={p:.2f}")

    n = len(scenarios)
    print("\n" + "=" * 64)
    print(f"scenarios          : {n}")
    print(f"gate would USE     : {used}/{n}  (the app would show these as 'checked online')")
    print(f"agrees with device : {agreed}/{n}")
    print(f"median latency     : {sorted(r['ms'] for r in results)[n // 2]:.0f} ms")
    print("Disagreements are the interesting rows — for each, decide which pick")
    print("YOU would actually have wanted. That, not accuracy on a benchmark,")
    print("is the Jev-vs-Laya-vs-device question for iAny.")

    json.dump({"model": args.model, "results": results}, open(args.out, "w"), indent=2)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
