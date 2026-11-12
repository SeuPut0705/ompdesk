//! A tray icon's pictures: `images: [{scaleFactor, dataURL}]` (PROTOCOL.md §7) to the RGBA pixels the tray takes.
//! The data URL carries PNG (what `NativeImage` holds) or ICO (PNG or BMP entries); the representation closest to the
//! display scale is the one decoded. Pure: no OS in here.

use std::io::Cursor;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

/// Straight (non-premultiplied) RGBA, row by row from the top.
#[derive(Debug, PartialEq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

/// The index of the representation whose `scaleFactor` is closest to `scale`; the larger one when two are equally
/// close (it is scaled down, not up).
pub fn pick(scales: &[f64], scale: f64) -> Option<usize> {
    let mut best: Option<usize> = None;
    for (i, s) in scales.iter().enumerate() {
        best = match best {
            None => Some(i),
            Some(b) => {
                let (db, di) = ((scales[b] - scale).abs(), (s - scale).abs());
                if di < db - 1e-9 || ((di - db).abs() <= 1e-9 && *s > scales[b]) {
                    Some(i)
                } else {
                    Some(b)
                }
            }
        };
    }
    best
}

/// The bytes of a `data:` URL (base64 or percent-encoded).
pub fn data_url_bytes(url: &str) -> Result<Vec<u8>, String> {
    let Some(rest) = url.strip_prefix("data:") else {
        return Err("the image is not a data URL".into());
    };
    let Some((head, body)) = rest.split_once(',') else {
        return Err("the data URL has no body".into());
    };
    if head.split(';').any(|p| p.eq_ignore_ascii_case("base64")) {
        let cleaned: String = body.chars().filter(|c| !c.is_whitespace()).collect();
        return STANDARD
            .decode(cleaned.as_bytes())
            .map_err(|e| format!("the data URL's base64 is invalid: {e}"));
    }
    let raw = body.as_bytes();
    let mut out = Vec::with_capacity(raw.len());
    let mut i = 0;
    while i < raw.len() {
        let escaped = (raw[i] == b'%')
            .then(|| raw.get(i + 1..i + 3))
            .flatten()
            .and_then(|hex| std::str::from_utf8(hex).ok())
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        if let Some(byte) = escaped {
            out.push(byte);
            i += 3;
        } else {
            out.push(raw[i]);
            i += 1;
        }
    }
    Ok(out)
}

const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Decodes PNG or ICO bytes; an ICO holding several sizes yields the one closest to `want_px` wide.
pub fn decode_image(bytes: &[u8], want_px: u32) -> Result<Rgba, String> {
    if bytes.starts_with(&PNG_SIGNATURE) {
        decode_png(bytes)
    } else if bytes.len() >= 6 && bytes[0] == 0 && bytes[1] == 0 && bytes[2] == 1 && bytes[3] == 0 {
        decode_ico(bytes, want_px)
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        Err("a JPEG cannot be a tray icon here: use PNG or ICO".into())
    } else {
        Err("the tray image is neither PNG nor ICO".into())
    }
}

pub fn decode_png(bytes: &[u8]) -> Result<Rgba, String> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
    let mut reader = decoder
        .read_info()
        .map_err(|e| format!("the PNG is invalid: {e}"))?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader
        .next_frame(&mut buf)
        .map_err(|e| format!("the PNG is invalid: {e}"))?;
    let pixels = &buf[..info.buffer_size()];
    let count = (info.width as usize) * (info.height as usize);
    let mut data = Vec::with_capacity(count * 4);
    match info.color_type {
        png::ColorType::Rgba => data.extend_from_slice(pixels),
        png::ColorType::Rgb => {
            for px in pixels.as_chunks::<3>().0 {
                data.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
        }
        png::ColorType::GrayscaleAlpha => {
            for px in pixels.as_chunks::<2>().0 {
                data.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
        }
        png::ColorType::Grayscale => {
            for g in pixels {
                data.extend_from_slice(&[*g, *g, *g, 255]);
            }
        }
        png::ColorType::Indexed => return Err("the PNG kept an indexed palette".into()),
    }
    if data.len() != count * 4 || count == 0 {
        return Err("the PNG has no pixels".into());
    }
    Ok(Rgba {
        width: info.width,
        height: info.height,
        data,
    })
}

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(bytes.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(bytes.get(at..at + 4)?.try_into().ok()?))
}

fn decode_ico(bytes: &[u8], want_px: u32) -> Result<Rgba, String> {
    let truncated = || "the ICO is truncated".to_string();
    let count = usize::from(u16_at(bytes, 4).ok_or_else(truncated)?);
    // (width, bit count, size, offset) of the entry closest to the wanted width, the deeper one on a tie.
    let mut best: Option<(u32, u16, usize, usize)> = None;
    for i in 0..count {
        let at = 6 + i * 16;
        let entry = bytes.get(at..at + 16).ok_or_else(truncated)?;
        let width = if entry[0] == 0 {
            256
        } else {
            u32::from(entry[0])
        };
        let bits = u16_at(bytes, at + 6).ok_or_else(truncated)?;
        let size = u32_at(bytes, at + 8).ok_or_else(truncated)? as usize;
        let offset = u32_at(bytes, at + 12).ok_or_else(truncated)? as usize;
        let distance = |w: u32| (i64::from(w) - i64::from(want_px)).abs();
        let better = match best {
            None => true,
            Some((bw, bb, _, _)) => {
                distance(width) < distance(bw) || (distance(width) == distance(bw) && bits > bb)
            }
        };
        if better {
            best = Some((width, bits, size, offset));
        }
    }
    let (_, _, size, offset) = best.ok_or_else(|| "the ICO has no images".to_string())?;
    let payload = bytes
        .get(offset..offset.checked_add(size).ok_or_else(truncated)?)
        .ok_or_else(truncated)?;
    if payload.starts_with(&PNG_SIGNATURE) {
        decode_png(payload)
    } else {
        decode_dib(payload)
    }
}

/// An ICO's BMP entry: a BITMAPINFOHEADER whose height counts the colour rows and the 1-bit AND mask.
fn decode_dib(dib: &[u8]) -> Result<Rgba, String> {
    let truncated = || "the ICO's bitmap is truncated".to_string();
    let header = u32_at(dib, 0).ok_or_else(truncated)? as usize;
    let width = u32_at(dib, 4).ok_or_else(truncated)? as i32;
    let height2 = u32_at(dib, 8).ok_or_else(truncated)? as i32;
    let bits = usize::from(u16_at(dib, 14).ok_or_else(truncated)?);
    let compression = u32_at(dib, 16).ok_or_else(truncated)?;
    let used = u32_at(dib, 32).ok_or_else(truncated)? as usize;
    if header < 40 || compression != 0 || width <= 0 || height2 <= 0 {
        return Err("the ICO's bitmap is compressed or malformed".into());
    }
    let (w, h) = (width as usize, (height2 as usize) / 2);
    if h == 0 || w > 4096 || h > 4096 {
        return Err("the ICO's bitmap has a bad size".into());
    }
    let palette_len = if bits <= 8 {
        if used == 0 { 1 << bits } else { used }
    } else {
        0
    };
    let palette = dib
        .get(header..header + palette_len * 4)
        .ok_or_else(truncated)?;
    let pixels_at = header + palette_len * 4;
    let stride = (w * bits).div_ceil(32) * 4;
    let mask_at = pixels_at + stride * h;
    let mask_stride = w.div_ceil(32) * 4;
    let rows = dib.get(pixels_at..mask_at).ok_or_else(truncated)?;
    let mask = dib.get(mask_at..mask_at + mask_stride * h);
    let mut data = vec![0u8; w * h * 4];
    let mut any_alpha = false;
    for y in 0..h {
        // Rows are stored bottom-up.
        let row = &rows[(h - 1 - y) * stride..(h - y) * stride];
        for x in 0..w {
            let out = (y * w + x) * 4;
            let (b, g, r, a) = match bits {
                32 => (row[x * 4], row[x * 4 + 1], row[x * 4 + 2], row[x * 4 + 3]),
                24 => (row[x * 3], row[x * 3 + 1], row[x * 3 + 2], 255),
                1 | 4 | 8 => {
                    let per_byte = 8 / bits;
                    let byte = row[x / per_byte];
                    let shift = 8 - bits * (x % per_byte + 1);
                    let index = usize::from((byte >> shift) & ((1u16 << bits) - 1) as u8);
                    let p = palette
                        .get(index * 4..index * 4 + 3)
                        .ok_or_else(truncated)?;
                    (p[0], p[1], p[2], 255)
                }
                other => return Err(format!("the ICO's bitmap has {other} bits per pixel")),
            };
            any_alpha |= a != 0;
            data[out..out + 4].copy_from_slice(&[r, g, b, a]);
        }
    }
    // A 32-bit bitmap with an alpha channel ignores the mask; every other depth is cut out by it.
    if !(bits == 32 && any_alpha) {
        for y in 0..h {
            for x in 0..w {
                let transparent = mask.is_some_and(|m| {
                    (m[(h - 1 - y) * mask_stride + x / 8] >> (7 - x % 8)) & 1 == 1
                });
                if transparent {
                    data[(y * w + x) * 4 + 3] = 0;
                } else if bits == 32 {
                    data[(y * w + x) * 4 + 3] = 255;
                }
            }
        }
    }
    Ok(Rgba {
        width: w as u32,
        height: h as u32,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn png_bytes(width: u32, height: u32, color: png::ColorType, pixels: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, width, height);
        encoder.set_color(color);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(pixels)
            .unwrap();
        out
    }

    #[test]
    fn the_representation_closest_to_the_display_scale_is_picked() {
        assert_eq!(pick(&[1.0, 2.0], 1.0), Some(0));
        assert_eq!(pick(&[1.0, 2.0], 2.0), Some(1));
        assert_eq!(pick(&[1.0, 2.0], 1.25), Some(0));
        assert_eq!(pick(&[1.0, 2.0], 1.75), Some(1));
        assert_eq!(pick(&[1.0, 2.0], 1.5), Some(1));
        assert_eq!(pick(&[2.0, 1.0], 1.5), Some(0));
        assert_eq!(pick(&[1.0], 3.0), Some(0));
        assert_eq!(pick(&[], 1.0), None);
    }

    #[test]
    fn data_urls_carry_base64_or_percent_encoded_bytes() {
        assert_eq!(
            data_url_bytes("data:image/png;base64,AQID").unwrap(),
            [1, 2, 3]
        );
        assert_eq!(
            data_url_bytes("data:image/png;base64,AQ ID").unwrap(),
            [1, 2, 3]
        );
        assert_eq!(data_url_bytes("data:,a%20b%7E").unwrap(), b"a b~");
        assert_eq!(data_url_bytes("data:,100%").unwrap(), b"100%");
        assert!(data_url_bytes("image/png;base64,AQID").is_err());
        assert!(data_url_bytes("data:image/png;base64").is_err());
        assert!(data_url_bytes("data:image/png;base64,@@@").is_err());
    }

    #[test]
    fn png_pixels_come_out_as_rgba() {
        let rgba = decode_image(
            &png_bytes(2, 1, png::ColorType::Rgba, &[1, 2, 3, 4, 5, 6, 7, 8]),
            16,
        )
        .unwrap();
        assert_eq!((rgba.width, rgba.height), (2, 1));
        assert_eq!(rgba.data, [1, 2, 3, 4, 5, 6, 7, 8]);
        let rgb = decode_image(&png_bytes(1, 1, png::ColorType::Rgb, &[9, 8, 7]), 16).unwrap();
        assert_eq!(rgb.data, [9, 8, 7, 255]);
        let gray = decode_image(
            &png_bytes(1, 1, png::ColorType::GrayscaleAlpha, &[5, 77]),
            16,
        )
        .unwrap();
        assert_eq!(gray.data, [5, 5, 5, 77]);
        let plain = decode_image(&png_bytes(1, 1, png::ColorType::Grayscale, &[200]), 16).unwrap();
        assert_eq!(plain.data, [200, 200, 200, 255]);
    }

    #[test]
    fn a_palette_png_is_expanded() {
        let mut out = Vec::new();
        let mut encoder = png::Encoder::new(&mut out, 2, 1);
        encoder.set_color(png::ColorType::Indexed);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_palette(vec![10, 20, 30, 40, 50, 60]);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&[1, 0])
            .unwrap();
        let rgba = decode_image(&out, 16).unwrap();
        assert_eq!(rgba.data, [40, 50, 60, 255, 10, 20, 30, 255]);
    }

    #[test]
    fn other_formats_are_refused_with_a_reason() {
        assert!(
            decode_image(&[0xFF, 0xD8, 0xFF, 0xE0], 16)
                .unwrap_err()
                .contains("JPEG")
        );
        assert!(decode_image(b"GIF89a", 16).is_err());
        assert!(decode_image(&PNG_SIGNATURE, 16).is_err());
    }

    fn ico(entries: &[(u8, Vec<u8>)]) -> Vec<u8> {
        let mut out = vec![0, 0, 1, 0];
        out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
        let mut offset = 6 + 16 * entries.len();
        for (size, payload) in entries {
            out.extend_from_slice(&[*size, *size, 0, 0, 1, 0, 32, 0]);
            out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
            out.extend_from_slice(&(offset as u32).to_le_bytes());
            offset += payload.len();
        }
        for (_, payload) in entries {
            out.extend_from_slice(payload);
        }
        out
    }

    /// A 32-bit BMP entry of `w`×`h`, every pixel `bgra`, with an all-opaque AND mask.
    fn dib32(w: u32, h: u32, bgra: [u8; 4]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(&40u32.to_le_bytes());
        out.extend_from_slice(&(w as i32).to_le_bytes());
        out.extend_from_slice(&((h * 2) as i32).to_le_bytes());
        out.extend_from_slice(&1u16.to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(&[0; 24]);
        for _ in 0..w * h {
            out.extend_from_slice(&bgra);
        }
        out.extend(std::iter::repeat_n(0u8, (w.div_ceil(32) * 4 * h) as usize));
        out
    }

    #[test]
    fn an_ico_yields_the_entry_closest_to_the_wanted_size() {
        let small = png_bytes(1, 1, png::ColorType::Rgba, &[1, 1, 1, 255]);
        let big = png_bytes(2, 2, png::ColorType::Rgba, &[2; 16]);
        let file = ico(&[(1, small), (2, big)]);
        assert_eq!(decode_image(&file, 1).unwrap().width, 1);
        assert_eq!(decode_image(&file, 2).unwrap().width, 2);
        assert_eq!(decode_image(&file, 32).unwrap().width, 2);
    }

    #[test]
    fn an_ico_bitmap_entry_is_decoded_bottom_up_as_rgba() {
        let file = ico(&[(2, dib32(2, 2, [30, 20, 10, 128]))]);
        let rgba = decode_image(&file, 2).unwrap();
        assert_eq!((rgba.width, rgba.height), (2, 2));
        assert_eq!(&rgba.data[..4], [10, 20, 30, 128]);
        assert_eq!(rgba.data.len(), 16);
    }

    #[test]
    fn an_ico_bitmap_without_alpha_is_cut_out_by_its_mask() {
        let mut dib = dib32(2, 1, [30, 20, 10, 0]);
        // The 2x1 entry's mask row is the last 4 bytes: the second pixel is transparent.
        let len = dib.len();
        dib[len - 4] = 0b0100_0000;
        let rgba = decode_image(&ico(&[(2, dib)]), 2).unwrap();
        assert_eq!(rgba.data, [10, 20, 30, 255, 10, 20, 30, 0]);
    }

    #[test]
    fn a_truncated_ico_is_an_error() {
        let file = ico(&[(2, dib32(2, 2, [0, 0, 0, 255]))]);
        assert!(decode_image(&file[..file.len() - 40], 2).is_err());
        assert!(decode_image(&[0, 0, 1, 0, 1, 0], 2).is_err());
    }
}
