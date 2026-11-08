"""合成 / 体检 E2E 截图。仅开发验收使用。"""
import json
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "screenshots")


def region_stats(img, box):
    crop = img.crop(box).convert("RGB")
    colors = crop.getcolors(maxcolors=1 << 20) or []
    total = crop.width * crop.height
    mean = tuple(round(sum(c[i] * n for n, c in colors) / total, 1) for i in range(3)) if total else (0, 0, 0)
    uniq = len(colors)
    return {"mean": mean, "unique": uniq, "size": (crop.width, crop.height)}


def compose(name):
    chrome_path = os.path.join(SHOTS, name)
    content_path = chrome_path.replace(".png", ".content.png")
    if not (os.path.exists(chrome_path) and os.path.exists(content_path)):
        return None
    chrome = Image.open(chrome_path).convert("RGB")
    content = Image.open(content_path).convert("RGB")
    top = chrome.height - content.height
    if chrome.width != content.width or top <= 0:
        return None
    out = Image.new("RGB", chrome.size)
    out.paste(chrome.crop((0, 0, chrome.width, top)), (0, 0))
    out.paste(content, (0, top))
    out_path = chrome_path.replace(".png", ".composite.png")
    out.save(out_path)
    return out_path, top


def main():
    report = []
    for name in sorted(os.listdir(SHOTS)):
        if not name.startswith("e2e-") or not name.endswith(".png"):
            continue
        if name.endswith(".content.png") or name.endswith(".composite.png") or name == "e2e-report.json":
            continue
        path = os.path.join(SHOTS, name)
        img = Image.open(path).convert("RGB")
        entry = {
            "name": name,
            "size": img.size,
            "titlebar": region_stats(img, (0, 0, img.width, min(42, img.height))),
            "toolbar": region_stats(img, (0, min(42, img.height), img.width, min(88, img.height))),
            "content": region_stats(img, (0, min(88, img.height), img.width, img.height)),
        }
        composed = compose(name)
        if composed:
            entry["composite"] = composed[0]
            entry["composite_top"] = composed[1]
        report.append(entry)
    out = os.path.join(ROOT, "logs", "shot-analysis.json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    for e in report:
        print(
            e["name"],
            e["size"],
            "titlebar", e["titlebar"]["mean"], e["titlebar"]["unique"],
            "toolbar", e["toolbar"]["mean"], e["toolbar"]["unique"],
            "content", e["content"]["mean"], e["content"]["unique"],
            ("composite:" + os.path.basename(e["composite"])) if "composite" in e else "",
        )
    print("analysis:", out)


if __name__ == "__main__":
    sys.exit(main())