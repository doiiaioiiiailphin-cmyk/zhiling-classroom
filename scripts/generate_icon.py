"""
生成知聆课堂 Windows 多尺寸高清透明应用图标 (assets/zhiling.ico & public/favicon.ico)
纯标准库实现，包含 256 / 128 / 64 / 48 / 32 / 16 六档 32-bit RGBA PNG 帧。
视觉风格：经典飞书办公蓝渐变圆角矩形 (#1456F0 -> #2B6BFF) + 白色抗锯齿声波纹图标。
"""
import math
from pathlib import Path
import struct
import zlib


def _png_chunk(tag: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(payload, zlib.crc32(tag)) & 0xFFFFFFFF
    return struct.pack(">I", len(payload)) + tag + payload + struct.pack(">I", crc)


def encode_rgba_png(rgba: bytes, size: int) -> bytes:
    stride = size * 4
    raw = bytearray((stride + 1) * size)
    mv_in = memoryview(rgba)
    mv_out = memoryview(raw)
    pos = 0
    for y in range(size):
        raw[pos] = 0
        row_start = y * stride
        mv_out[pos + 1 : pos + 1 + stride] = mv_in[row_start : row_start + stride]
        pos += 1 + stride
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    idat = zlib.compress(bytes(raw), level=6)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", idat)
        + _png_chunk(b"IEND", b"")
    )


def _sd_rounded_box(px: float, py: float, half: float, radius: float) -> float:
    qx = abs(px) - (half - radius)
    qy = abs(py) - (half - radius)
    out_dist = math.hypot(max(qx, 0.0), max(qy, 0.0))
    in_dist = min(max(qx, qy), 0.0)
    return out_dist + in_dist - radius


def _sd_capsule_y(px: float, py: float, cx: float, half_h: float, radius: float) -> float:
    dx = abs(px - cx)
    dy = max(abs(py) - half_h, 0.0)
    return math.hypot(dx, dy) - radius


def render_icon_rgba(size: int) -> bytes:
    buf = bytearray(size * size * 4)
    inv = 1.0 / size
    aa = 1.35 * inv

    # 5 根对称课堂声波柱: (x 偏移, 半高)
    bars = (
        (-0.23, 0.095),
        (-0.115, 0.195),
        (0.0, 0.265),
        (0.115, 0.165),
        (0.23, 0.085),
    )
    bar_radius = 0.036

    idx = 0
    for y in range(size):
        ny = (y + 0.5) * inv - 0.5
        t_grad = (y + 0.5) * inv
        # 经典飞书办公蓝微渐变: 顶部 #2B6BFF (43,107,255) -> 底部 #124BE6 (18,75,230)
        bg_r = 43.0 + (18.0 - 43.0) * t_grad
        bg_g = 107.0 + (75.0 - 107.0) * t_grad
        bg_b = 255.0 + (230.0 - 255.0) * t_grad

        for x in range(size):
            nx = (x + 0.5) * inv - 0.5
            d_box = _sd_rounded_box(nx, ny, 0.445, 0.115)
            alpha_box = max(0.0, min(1.0, 0.5 - d_box / aa))

            if alpha_box <= 0.0:
                idx += 4
                continue

            d_bar = min(_sd_capsule_y(nx, ny, bx, bh, bar_radius) for bx, bh in bars)
            w_bar = max(0.0, min(1.0, 0.5 - d_bar / aa))

            r = int(round(bg_r * (1.0 - w_bar) + 255.0 * w_bar))
            g = int(round(bg_g * (1.0 - w_bar) + 255.0 * w_bar))
            b = int(round(bg_b * (1.0 - w_bar) + 255.0 * w_bar))
            a = int(round(alpha_box * 255.0))

            buf[idx] = max(0, min(255, r))
            buf[idx + 1] = max(0, min(255, g))
            buf[idx + 2] = max(0, min(255, b))
            buf[idx + 3] = max(0, min(255, a))
            idx += 4

    return bytes(buf)


def build_ico(sizes: tuple[int, ...] = (16, 32, 48, 64, 128, 256)) -> bytes:
    frames = [(s, encode_rgba_png(render_icon_rgba(s), s)) for s in sizes]
    header = struct.pack("<HHH", 0, 1, len(frames))
    entries = bytearray()
    payloads = bytearray()
    offset = 6 + 16 * len(frames)

    for s, png in frames:
        w_byte = 0 if s >= 256 else s
        h_byte = 0 if s >= 256 else s
        entries.extend(
            struct.pack(
                "<BBBBHHII",
                w_byte,
                h_byte,
                0,
                0,
                1,
                32,
                len(png),
                offset,
            )
        )
        payloads.extend(png)
        offset += len(png)

    return header + bytes(entries) + bytes(payloads)


def build_icns() -> bytes:
    """构建原生 macOS .icns 图标容器（PNG 编码块：128 / 256 / 512 / 1024）。"""
    # Apple ICNS OSType -> PNG 像素尺寸
    icns_entries = (
        (b"ic07", 128),
        (b"ic08", 256),
        (b"ic09", 512),
        (b"ic10", 1024),
    )
    body = bytearray()
    for tag, size in icns_entries:
        png = encode_rgba_png(render_icon_rgba(size), size)
        body.extend(tag)
        body.extend(struct.pack(">I", 8 + len(png)))
        body.extend(png)
    total_len = 8 + len(body)
    return b"icns" + struct.pack(">I", total_len) + bytes(body)


def main() -> None:
    root = Path(__file__).resolve().parent.parent
    ico_bytes = build_ico()

    assets_ico = root / "assets" / "zhiling.ico"
    assets_ico.parent.mkdir(parents=True, exist_ok=True)
    assets_ico.write_bytes(ico_bytes)

    assets_icns = root / "assets" / "zhiling.icns"
    icns_bytes = build_icns()
    assets_icns.write_bytes(icns_bytes)

    public_ico = root / "public" / "favicon.ico"
    public_ico.parent.mkdir(parents=True, exist_ok=True)
    public_ico.write_bytes(build_ico((16, 32, 48)))

    print(
        f"Generated {assets_ico} ({len(ico_bytes)} bytes), "
        f"{assets_icns} ({len(icns_bytes)} bytes), and {public_ico}"
    )


if __name__ == "__main__":
    main()
