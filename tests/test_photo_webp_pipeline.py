"""Server-side WebP pipeline: formats, orientation, alpha, metadata, limits, duplicates and rollback."""
import io
import uuid

import pytest
from fastapi import HTTPException
from PIL import Image

from app.core.models import Plant, SitePhoto
from app.photos.imaging import PhotoSettings, optimize_photo
from tests.conftest import login_user
from tests.test_photo_live_api import StorageStub, fake_storage  # noqa: F401  (autouse storage stub)

SETTINGS = PhotoSettings()


def encode(img, fmt, **kw):
    out = io.BytesIO(); img.save(out, format=fmt, **kw); return out.getvalue()


def photo_like(w, h):
    """Noise + gradient: compresses like a real site photo rather than a flat colour."""
    noise = Image.effect_noise((w, h), 25).convert("RGB")
    grad = Image.linear_gradient("L").resize((w, h)).convert("RGB")
    return Image.blend(noise, grad, 0.6)


def gps_exif(orientation=1):
    exif = Image.Exif()
    exif[0x0112] = orientation
    exif[0x010F] = "PhoneMaker"
    exif[0x8825] = {1: "N", 2: (28.0, 36.0, 0.0), 3: "E", 4: (77.0, 12.0, 0.0)}  # GPS IFD
    return exif


def decoded(data):
    img = Image.open(io.BytesIO(data)); img.load(); return img


def test_jpeg_becomes_upright_webp_without_gps_and_never_upscaled():
    # 300x200 stored sideways with orientation 6 (rotate 90° clockwise to view)
    src = photo_like(300, 200)
    data = encode(src, "JPEG", quality=92, exif=gps_exif(6))
    out = optimize_photo(data, "image/jpeg", SETTINGS)
    img = decoded(out.data)
    assert img.format == "WEBP" and out.content_type == "image/webp" and out.reencoded
    assert img.size == (200, 300), "EXIF orientation applied once, not lost and not doubled"
    assert not img.info.get("exif") and not img.getexif(), "camera EXIF/GPS is stripped"
    assert (out.width, out.height) == (200, 300)  # small photo: no upscaling


def test_large_jpeg_downscaled_to_max_side_and_thumbnail_smaller():
    data = encode(photo_like(4000, 3000), "JPEG", quality=90)
    out = optimize_photo(data, "image/jpeg", SETTINGS)
    assert max(decoded(out.data).size) == 2048
    thumb = decoded(out.thumbnail)
    assert thumb.format == "WEBP" and max(thumb.size) <= 640
    assert len(out.thumbnail) < len(out.data) < len(data)


def test_png_alpha_kept_as_lossless_webp_without_background_fill():
    src = Image.new("RGBA", (120, 80), (0, 0, 0, 0))
    src.paste((200, 30, 30, 255), (10, 10, 60, 60))
    out = optimize_photo(encode(src, "PNG"), "image/png", SETTINGS)
    img = decoded(out.data).convert("RGBA")
    assert img.getpixel((100, 70))[3] == 0, "transparent stays transparent (no white/black box)"
    assert img.getpixel((20, 20)) == (200, 30, 30, 255), "PNG is encoded losslessly"
    assert decoded(out.thumbnail).mode == "RGBA"


def test_palette_png_with_transparency_and_greyscale():
    pal = Image.new("P", (40, 40), 0); pal.info["transparency"] = 0
    assert decoded(optimize_photo(encode(pal, "PNG", transparency=0), "image/png", SETTINGS).data).mode == "RGBA"
    grey = Image.new("L", (40, 40), 128)
    assert decoded(optimize_photo(encode(grey, "PNG"), "image/png", SETTINGS).data).mode == "RGB"


def test_phone_webp_within_limits_is_stored_byte_for_byte():
    data = encode(photo_like(800, 600), "WEBP", quality=80)
    out = optimize_photo(data, "image/webp", SETTINGS)
    assert out.data == data and not out.reencoded


def test_webp_with_metadata_or_oversized_is_reencoded():
    with_exif = encode(photo_like(400, 300), "WEBP", quality=80, exif=gps_exif())
    out = optimize_photo(with_exif, "image/webp", SETTINGS)
    assert out.reencoded and not decoded(out.data).getexif()
    big = encode(photo_like(3000, 1000), "WEBP", quality=80)
    assert max(decoded(optimize_photo(big, "image/webp", SETTINGS).data).size) == 2048


@pytest.mark.parametrize("data,mime,code", [
    (b"notajpeg" * 10, "image/jpeg", 415),
    (encode(Image.new("RGB", (20, 20)), "PNG"), "image/jpeg", 415),        # bytes do not match declared type
    (encode(Image.new("RGB", (64, 64)), "JPEG")[:120], "image/jpeg", 415),  # truncated
])
def test_invalid_or_mismatched_images_rejected(data, mime, code):
    with pytest.raises(HTTPException) as e:
        optimize_photo(data, mime, SETTINGS)
    assert e.value.status_code == code


def test_decompression_bomb_dimensions_rejected():
    data = encode(Image.new("1", (8000, 8000)), "PNG")  # 64 MP, tiny file
    with pytest.raises(HTTPException) as e:
        optimize_photo(data, "image/png", SETTINGS)
    assert e.value.status_code in (413, 415)


def test_animated_webp_rejected():
    frames = [Image.new("RGB", (30, 30), c) for c in ("red", "blue")]
    out = io.BytesIO(); frames[0].save(out, format="WEBP", save_all=True, append_images=frames[1:])
    with pytest.raises(HTTPException) as e:
        optimize_photo(out.getvalue(), "image/webp", SETTINGS)
    assert e.value.status_code == 415


def _plant(db):
    p = Plant(site_code="WEBP1", plant_name="WebP Plant"); db.add(p); db.commit(); db.refresh(p); return p


def _post(client, p, files, submission=None):
    data = {"plant_id": str(p.id), "category": "other"}
    if submission: data["submission_id"] = submission
    return client.post("/api/photos", data=data, files=files)


def test_api_stores_webp_with_byte_count_and_original_filename(client, db):
    login_user(client, db); p = _plant(db)
    jpeg = encode(photo_like(3000, 2000), "JPEG", quality=90, exif=gps_exif())
    r = _post(client, p, [("files", ("IMG_0001.JPG", io.BytesIO(jpeg), "image/jpeg"))])
    assert r.status_code == 201, r.text
    row = db.query(SitePhoto).one()
    stored = StorageStub.objects[row.storage_path][0]
    assert row.storage_path.endswith(".webp") and row.content_type == "image/webp"
    assert row.size_bytes == len(stored) < len(jpeg) and row.file_name == "IMG_0001.JPG"
    assert not decoded(stored).getexif()


def test_duplicate_submission_returns_saved_photos_without_new_objects(client, db):
    login_user(client, db); p = _plant(db)
    sid = str(uuid.uuid4())
    files = lambda: [("files", (f"p{i}.png", io.BytesIO(encode(photo_like(64, 64), "PNG")), "image/png")) for i in range(2)]
    first = _post(client, p, files(), sid)
    assert first.status_code == 201
    objects = dict(StorageStub.objects)
    again = _post(client, p, files(), sid)
    assert again.status_code == 200 and again.json()["duplicate"] is True
    assert [x["id"] for x in again.json()["records"]] == [x["id"] for x in first.json()["records"]]
    assert db.query(SitePhoto).count() == 2 and StorageStub.objects == objects
    other = Plant(site_code="WEBP2", plant_name="Other"); db.add(other); db.commit()
    assert _post(client, other, files(), sid).status_code == 409


def test_failure_on_later_photo_removes_earlier_objects_and_saves_nothing(client, db):
    login_user(client, db); p = _plant(db)
    good = encode(photo_like(64, 64), "JPEG")
    broken = good[:200]  # valid header, cannot be decoded
    r = _post(client, p, [("files", ("a.jpg", io.BytesIO(good), "image/jpeg")),
                         ("files", ("b.jpg", io.BytesIO(broken), "image/jpeg"))])
    assert r.status_code == 415
    assert db.query(SitePhoto).count() == 0 and not StorageStub.objects


def test_unsupported_type_rejected_before_anything_is_stored(client, db):
    login_user(client, db); p = _plant(db)
    r = _post(client, p, [("files", ("a.jpg", io.BytesIO(encode(photo_like(64, 64), "JPEG")), "image/jpeg")),
                         ("files", ("b.gif", io.BytesIO(b"GIF89a" + b"0" * 64), "image/gif"))])
    assert r.status_code == 415 and not StorageStub.objects


def test_representative_byte_savings_are_reported(capsys):
    """Not a promise of a fixed saving: prints actual sizes for a few representative synthetic photos."""
    for w, h, q in ((4032, 3024, 92), (1920, 1080, 85), (1280, 960, 80)):
        jpeg = encode(photo_like(w, h), "JPEG", quality=q)
        out = optimize_photo(jpeg, "image/jpeg", SETTINGS)
        print(f"{w}x{h} JPEG q{q}: {len(jpeg)} B -> WebP {len(out.data)} B, thumb {len(out.thumbnail)} B")
        assert len(out.thumbnail) < len(out.data)
