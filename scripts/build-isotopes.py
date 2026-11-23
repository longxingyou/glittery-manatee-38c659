#!/usr/bin/env python3
"""
逐核素同位素数据构建脚本。

数据源：mendeleev（Python 包，IUPAC/NUBASE 数据）。
为每个元素挑选有教学价值的核素：
  1. 全部稳定同位素
  2. 全部天然丰度 > 0 的同位素
  3. 若无稳定同位素，则取寿命最长的放射性同位素
输出：src/lib/isotopes.json —— 以元素符号为键，值为核素数组。
每个核素是紧凑数组 [A, 质量, 丰度%, 稳定?, 衰变方式, 半衰期数值, 半衰期单位]。

运行：py -3.14 scripts/build-isotopes.py
"""
import json
import sys
from pathlib import Path

try:
    from mendeleev import element
except ImportError:
    sys.exit("缺少 mendeleev 包：py -3.14 -m pip install mendeleev")

# 半衰期单位 → 秒，用于挑选最长寿命核素
SEC_PER_UNIT = {
    "nsec": 1e-9, "usec": 1e-6, "msec": 1e-3, "sec": 1,
    "minute": 60, "hour": 3600, "day": 86400,
    "year": 31557600, "kyear": 31557600e3,
    "Myear": 31557600e6, "Gyear": 31557600e9,
}


def is_stable_nuclide(iso) -> bool:
    """稳定核素：无衰变方式且无半衰期（mendeleev 的 is_stable 字段对部分核素标注错误）"""
    return not iso.decay_modes and iso.half_life is None


def fmt_decay(iso) -> str:
    if not iso.decay_modes:
        return ""
    parts = []
    for d in iso.decay_modes:
        if d.intensity is not None:
            parts.append(f"{d.mode}({d.intensity:g}%)")
        else:
            parts.append(d.mode)
    return ", ".join(parts)


def main():
    out = {}
    for z in range(1, 119):
        el = element(z)
        isos = el.isotopes
        chosen = {}  # mass_number -> isotope

        # 1. 稳定同位素
        for iso in isos:
            if is_stable_nuclide(iso):
                chosen[iso.mass_number] = iso

        # 2. 有天然丰度的
        for iso in isos:
            if iso.abundance and iso.abundance > 0:
                chosen.setdefault(iso.mass_number, iso)

        # 3. 无稳定同位素时，取寿命最长的
        if not any(is_stable_nuclide(i) for i in chosen.values()):
            with_hl = [
                (i, i.half_life * SEC_PER_UNIT[i.half_life_unit])
                for i in isos
                if i.half_life is not None and i.half_life_unit in SEC_PER_UNIT
            ]
            if with_hl:
                longest = max(with_hl, key=lambda x: x[1])[0]
                chosen.setdefault(longest.mass_number, longest)

        rows = []
        for a in sorted(chosen):
            iso = chosen[a]
            hl_val = iso.half_life
            hl_unit = iso.half_life_unit or ""
            # 稳定同位素统一置空半衰期
            if is_stable_nuclide(iso):
                hl_val = None
                hl_unit = ""
            rows.append([
                iso.mass_number,
                round(float(iso.mass), 8) if iso.mass is not None else None,
                round(float(iso.abundance), 6) if iso.abundance else None,
                is_stable_nuclide(iso),
                fmt_decay(iso),
                hl_val,
                hl_unit,
            ])
        out[el.symbol] = rows

    target = Path(__file__).resolve().parent.parent / "src" / "lib" / "isotopes.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    total = sum(len(v) for v in out.values())
    print(f"✓ 写入 {target}，{len(out)} 个元素，{total} 个核素")
    print(f"  - 文件大小：{target.stat().st_size / 1024:.1f} KB")
    print("  - 数据源：mendeleev (IUPAC/NUBASE)")


if __name__ == "__main__":
    main()
