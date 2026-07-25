#!/usr/bin/env python3
"""将 StandCode stands 同步为 concrete areco 模板。"""
import json
import os

STANDCODE_DIR = "/Users/gao/Code/StandCode/config"
ARECO_CONFIG = "/Users/gao/Code/areco/config.json"


def load_config(name):
    with open(os.path.join(STANDCODE_DIR, f"{name}.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def resolve_stand(stand_id, stand):
    """把 stand 的 harness + model + preset 解析成具体 command/args。"""
    harnesses = load_config("harnesses")
    models = load_config("models")
    presets = load_config("presets")

    harness = harnesses.get("harnesses", {}).get(stand["harness"])
    model = models.get("models", {}).get(stand.get("model", ""))
    preset = presets.get("presets", {}).get(stand.get("preset", ""))

    if not harness:
        raise ValueError(f"stand {stand_id}: harness {stand['harness']} not found")

    command = harness["command"]
    args = list(harness.get("args", []))

    if stand["harness"] == "workbuddy":
        if model and model.get("model_id"):
            # workbuddy 模板格式：--model 放前面，--dangerously-skip-permissions 随后
            args = ["--model", model["model_id"], "--dangerously-skip-permissions"]
    elif stand["harness"] == "openclaw":
        if model and model.get("model_id"):
            args.extend(["--model", model["model_id"]])
        if preset and preset.get("timeout"):
            args.extend(["--timeout", str(preset["timeout"])])
        if preset and preset.get("agent"):
            args.extend(["--agent", preset["agent"]])
        args.append("--json")
    elif stand["harness"] == "reasonix":
        if stand.get("model"):
            args.extend(["--model", stand["model"]])

    return {
        "command": command,
        "args": args,
        "cwd": harness.get("cwd", stand.get("cwd", "/Users/gao")),
    }


def main():
    stands = load_config("stands")
    with open(ARECO_CONFIG, "r", encoding="utf-8") as f:
        areco = json.load(f)

    # 移除旧的 stand-* 模板
    areco["templates"] = [t for t in areco["templates"] if not t["id"].startswith("stand-")]

    for stand_id, stand in stands.get("stands", {}).items():
        resolved = resolve_stand(stand_id, stand)
        template_id = f"stand-{stand_id}"
        areco["templates"].append({
            "id": template_id,
            "name": stand.get("description", stand_id),
            "command": resolved["command"],
            "args": resolved["args"],
            "cwd": resolved["cwd"],
            "color": stand.get("color", "#4d6bfe"),
            "autoStart": False,
            "enabled": True,
            # StandCode 元信息（areco 未来可原生支持）
            "harness": stand["harness"],
            "model": stand.get("model"),
            "preset": stand.get("preset"),
        })
        print(f"synced {template_id}: {resolved['command']} {' '.join(resolved['args'])}")

    with open(ARECO_CONFIG, "w", encoding="utf-8") as f:
        json.dump(areco, f, ensure_ascii=False, indent=2)
    print(f"saved {ARECO_CONFIG}")


if __name__ == "__main__":
    main()
