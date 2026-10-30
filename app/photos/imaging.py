"""Server-side WebP pipeline for Photo Intelligence uploads (one photo at a time, bounded memory).

Every accepted photo is decoded (not just header-checked), so corrupt files and decompression bombs are rejected.
The stored original is a WebP display copy: upright (EXIF orientation applied), at most PHOTO_MAX_SIDE px, and
without EXIF/XMP metadata (camera GPS and serial numbers are not kept); the colour profile is kept. A WebP that the
phone already produced within those limits and without metadata is stored byte-for-byte, so it is not compressed a
second time. PNG sources are encoded as *lossless* WebP: PNG is chosen for screenshots and drawings whose exact
pixels matter. Reports, PDFs and other fidelity-critical files belong in Equipment Documents, which are never
recompressed.
"""
from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO

import warnings

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError

MAX_PIXELS = 36_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS  # Pillow raises DecompressionBombError above twice this
_MAGIC = {
    "image/jpeg": lambda b: b[:3] == b"\xff\xd8\xff",
    "image/png": lambda b: b[:8] == b"\x89PNG\r\n\x1a\n",
    "image/webp": lambda b: b[:4] == b"RIFF" and b[8:12] == b"WEBP",
}
_FORMATS = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}


@dataclass(frozen=True)
class PhotoSettings:
    max_side: int = 2048
    quality: int = 80
    thumb_side: int = 640
    thumb_quality: int = 70
    method: int = 4


@dataclass
class OptimizedPhoto:
    data: bytes
    thumbnail: bytes
    width: int
    height: int
    reencoded: bool
    content_type: str = "image/webp"


def header_matches(mime: str, head: bytes) -> bool:
    check = _MAGIC.get(mime)
    return bool(check and check(head))


def _has_alpha(img: Image.Image) -> bool:
    return "A" in img.getbands() or "transparency" in img.info


def _normalise_mode(img: Image.Image) -> Image.Image:
    if img.mode in ("RGB", "RGBA"):
        return img
    # palette/greyscale transparency becomes a real alpha channel: no black or white box behind it
    return img.convert("RGBA" if _has_alpha(img) else "RGB")


def _webp(img: Image.Image, *, quality: int, method: int, lossless: bool, icc: bytes | None) -> bytes:
    out = BytesIO()
    options = {"method": method, "lossless": lossless, "quality": 100 if lossless else quality}
    if icc:
        options["icc_profile"] = icc
    img.save(out, format="WEBP", **options)  # no exif=/xmp= → metadata is not written
    return out.getvalue()


def optimize_photo(data: bytes, mime: str, settings: PhotoSettings) -> OptimizedPhoto:
    if not header_matches(mime, data):
        raise HTTPException(415, "The selected file is not a valid JPEG, PNG, or WebP photo")
    try:
        with warnings.catch_warnings():
            # Pillow warns while reading the header of an image between 1x and 2x MAX_PIXELS; the explicit
            # check below rejects it with 413 before anything is decoded, so the warning is only log noise.
            warnings.simplefilter("ignore", Image.DecompressionBombWarning)
            src = Image.open(BytesIO(data))
        with src:
            if src.format != _FORMATS[mime]:
                raise HTTPException(415, "The photo content does not match its file type")
            if src.width * src.height > MAX_PIXELS:
                raise HTTPException(413, "Photo dimensions are too large")
            if getattr(src, "n_frames", 1) > 1:
                raise HTTPException(415, "Animated images are not supported; upload a still photo")
            icc = src.info.get("icc_profile")
            orientation = src.getexif().get(0x0112, 1)
            keep = (mime == "image/webp" and max(src.size) <= settings.max_side and orientation in (0, 1)
                    and not src.info.get("exif") and not src.info.get("xmp"))
            if mime == "image/jpeg":
                # decode at 1/2–1/8 scale when the photo is far larger than needed (much less memory and CPU)
                src.draft("RGB", (settings.max_side, settings.max_side))
            src.load()  # full decode: corrupt or truncated files fail here, not later in a browser
            img = _normalise_mode(ImageOps.exif_transpose(src))
        if keep:
            stored = data
        else:
            img.thumbnail((settings.max_side, settings.max_side), Image.Resampling.LANCZOS)  # never enlarges
            stored = _webp(img, quality=settings.quality, method=settings.method, lossless=mime == "image/png", icc=icc)
        width, height = img.size
        img.thumbnail((settings.thumb_side, settings.thumb_side), Image.Resampling.LANCZOS)
        thumb = _webp(img, quality=settings.thumb_quality, method=settings.method, lossless=False, icc=icc)
        img.close()
        return OptimizedPhoto(data=stored, thumbnail=thumb, width=width, height=height, reencoded=not keep)
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError):
        raise HTTPException(415, "This photo could not be decoded. Try a valid JPEG, PNG or WebP photo") from None
