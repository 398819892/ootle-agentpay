"""Render an accepted payment as a small PNG receipt (optional).

Pure presentation: given the receipt figures, draw a card and return PNG bytes. It needs Pillow
and a usable font; if either is missing (or anything goes wrong), ``render_receipt_png`` returns
``None`` and the caller falls back to the text / JSON receipt. The image is a nicety — a payment is
always reported with or without it, so a render failure never turns a good pay into an error.
"""
from __future__ import annotations

import io
from typing import Optional

try:
    from PIL import Image, ImageDraw, ImageFont
    _PIL_OK = True
except Exception:  # noqa: BLE001 - Pillow not installed; receipts degrade to text
    _PIL_OK = False

# Candidate fonts: a CJK-capable face first (the labels are Chinese), then Latin, then the default.
_REGULAR = [
    "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/simsun.ttc", "C:/Windows/Fonts/arial.ttf",
]
_BOLD = [
    "C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/simhei.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
] + _REGULAR


def _font(paths, size):
    for p in paths:
        try:
            return ImageFont.truetype(p, size)
        except Exception:  # noqa: BLE001 - try the next candidate
            continue
    return ImageFont.load_default()


def _fmt_amount(v) -> str:
    try:
        return f"{int(v):,}"
    except (TypeError, ValueError):
        return "—"


def _fmt_time(s) -> str:
    if not s:
        return "—"
    s = str(s)
    if "T" in s:               # ISO-8601 "2026-11-05T09:30:27+08:00" -> "2026-11-05 09:30:27"
        d, t = s.split("T", 1)
        return f"{d} {t[:8]}"
    return s[:19]


def _short_merchant(m) -> str:
    m = str(m if m is not None else "—")
    if m.startswith("component_") and len(m) > 26:
        return f"{m[:16]}…{m[-6:]}"
    return m


def render_receipt_png(*, merchant, amount, memo="", remaining_balance=None,
                       remaining_in_window=None, paid_at=None, unit="µT") -> Optional[bytes]:
    """Return a PNG receipt as bytes, or ``None`` if it cannot be rendered."""
    if not _PIL_OK:
        return None
    try:
        S = 2  # supersample, then downscale for crisp text

        # palette
        bg = (245, 246, 250)
        card = (255, 255, 255)
        ink = (26, 27, 42)
        muted = (138, 140, 160)
        brand = (108, 92, 231)
        line = (233, 234, 240)
        ok = (34, 170, 110)

        f_brand = _font(_BOLD, 22 * S)
        f_title = _font(_REGULAR, 14 * S)
        f_ok = _font(_BOLD, 22 * S)
        f_amount = _font(_BOLD, 40 * S)
        f_label = _font(_REGULAR, 15 * S)
        f_value = _font(_BOLD, 16 * S)
        f_foot = _font(_REGULAR, 12 * S)

        rows = [
            ("商户  Merchant", _short_merchant(merchant)),
            ("备注  Memo", str(memo) if memo else "—"),
            ("剩余金额  Balance", f"{_fmt_amount(remaining_balance)} {unit}"),
            ("本窗口剩余  Window left", f"{_fmt_amount(remaining_in_window)} {unit}"),
            ("付款时间  Time", _fmt_time(paid_at)),
        ]

        W = 720 * S
        margin = 16 * S          # card inset from the image edge
        pad = 34 * S             # content inset from the card edge
        header_h = 60 * S
        ok_h = 40 * S
        amount_h = 58 * S
        row_h = 46 * S
        foot_h = 48 * S
        H = margin + header_h + ok_h + amount_h + row_h * len(rows) + foot_h + margin

        img = Image.new("RGB", (W, H), bg)
        d = ImageDraw.Draw(img)

        cx0, cy0, cx1, cy1 = margin, margin, W - margin, H - margin
        d.rounded_rectangle([cx0, cy0, cx1, cy1], radius=18 * S, fill=card)

        # header band (square off the bottom corners so only the top is rounded)
        d.rounded_rectangle([cx0, cy0, cx1, cy0 + header_h], radius=18 * S, fill=brand)
        d.rectangle([cx0, cy0 + header_h - 18 * S, cx1, cy0 + header_h], fill=brand)
        hy = cy0 + header_h // 2
        d.text((cx0 + pad, hy), "AgentPay", font=f_brand, fill=(255, 255, 255), anchor="lm")
        d.text((cx1 - pad, hy), "付款回执 · Payment Receipt", font=f_title, fill=(232, 228, 255), anchor="rm")

        y = cy0 + header_h
        # a drawn green check badge (a ✓ glyph is missing from some bold CJK faces, so we draw it)
        by = y + ok_h // 2
        r = 11 * S
        bx = cx0 + pad + r
        d.ellipse([bx - r, by - r, bx + r, by + r], fill=ok)
        d.line([(bx - 5 * S, by), (bx - 1 * S, by + 4 * S)], fill=(255, 255, 255), width=2 * S)
        d.line([(bx - 1 * S, by + 4 * S), (bx + 6 * S, by - 5 * S)], fill=(255, 255, 255), width=2 * S)
        d.text((bx + r + 10 * S, by), "付款成功", font=f_ok, fill=ok, anchor="lm")
        y += ok_h
        d.text((cx0 + pad, y + amount_h // 2), f"{_fmt_amount(amount)} {unit}",
               font=f_amount, fill=ink, anchor="lm")
        y += amount_h

        for label, value in rows:
            d.line([cx0 + pad, y, cx1 - pad, y], fill=line, width=max(1, S))
            ry = y + row_h // 2
            d.text((cx0 + pad, ry), label, font=f_label, fill=muted, anchor="lm")
            d.text((cx1 - pad, ry), value, font=f_value, fill=ink, anchor="rm")
            y += row_h

        d.line([cx0 + pad, y, cx1 - pad, y], fill=line, width=max(1, S))
        d.text((cx0 + pad, y + foot_h // 2), "Tari Ootle validator · 链上已确认",
               font=f_foot, fill=muted, anchor="lm")

        img = img.resize((W // S, H // S), Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:  # noqa: BLE001 - a render failure must never break the payment
        return None
