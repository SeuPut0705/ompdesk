//! A painted frame (BGRA, as CEF hands it) encoded for `wc.frame`: scaled down on request, then JPEG or PNG. Only
//! what is asked for is encoded, never on paint.

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Format {
    Jpeg,
    Png,
}

/// Area-average downscale of a BGRA frame to `target_width` (never larger than the source), keeping the aspect.
pub fn scale_bgra(bgra: &[u8], width: u32, height: u32, target_width: u32) -> (Vec<u8>, u32, u32) {
    if target_width == 0 || target_width >= width {
        return (bgra.to_vec(), width, height);
    }
    let target_height =
        ((u64::from(height) * u64::from(target_width)) / u64::from(width)).max(1) as u32;
    let mut out = vec![0u8; target_width as usize * target_height as usize * 4];
    for ty in 0..target_height {
        let y0 = (u64::from(ty) * u64::from(height) / u64::from(target_height)) as u32;
        let y1 = (((u64::from(ty) + 1) * u64::from(height) / u64::from(target_height)) as u32)
            .clamp(y0 + 1, height);
        for tx in 0..target_width {
            let x0 = (u64::from(tx) * u64::from(width) / u64::from(target_width)) as u32;
            let x1 = (((u64::from(tx) + 1) * u64::from(width) / u64::from(target_width)) as u32)
                .clamp(x0 + 1, width);
            let mut sum = [0u64; 4];
            for y in y0..y1 {
                let row = y as usize * width as usize * 4;
                for x in x0..x1 {
                    let p = row + x as usize * 4;
                    for (c, s) in sum.iter_mut().enumerate() {
                        *s += u64::from(bgra[p + c]);
                    }
                }
            }
            let count = u64::from((y1 - y0) * (x1 - x0));
            let o = (ty as usize * target_width as usize + tx as usize) * 4;
            for (c, s) in sum.iter().enumerate() {
                out[o + c] = (s / count) as u8;
            }
        }
    }
    (out, target_width, target_height)
}

/// Encodes a BGRA frame; returns the bytes and the size actually encoded.
pub fn encode(
    bgra: &[u8],
    width: u32,
    height: u32,
    format: Format,
    quality: u8,
    target_width: Option<u32>,
) -> Result<(Vec<u8>, u32, u32), String> {
    if bgra.len() != width as usize * height as usize * 4 || width == 0 || height == 0 {
        return Err(format!(
            "a {width}x{height} frame needs {} bytes, got {}",
            width as usize * height as usize * 4,
            bgra.len()
        ));
    }
    let (pixels, w, h) = match target_width {
        Some(t) => scale_bgra(bgra, width, height, t),
        None => (bgra.to_vec(), width, height),
    };
    let mut out = Vec::new();
    match format {
        Format::Jpeg => {
            let rgb: Vec<u8> = pixels
                .chunks_exact(4)
                .flat_map(|p| [p[2], p[1], p[0]])
                .collect();
            let encoder = jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100));
            let (jw, jh) = (
                u16::try_from(w).map_err(|_| "frame too wide for JPEG")?,
                u16::try_from(h).map_err(|_| "frame too tall for JPEG")?,
            );
            encoder
                .encode(&rgb, jw, jh, jpeg_encoder::ColorType::Rgb)
                .map_err(|e| e.to_string())?;
        }
        Format::Png => {
            let rgba: Vec<u8> = pixels
                .chunks_exact(4)
                .flat_map(|p| [p[2], p[1], p[0], p[3]])
                .collect();
            let mut encoder = png::Encoder::new(&mut out, w, h);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.set_compression(png::Compression::Fast);
            let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
            writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
            writer.finish().map_err(|e| e.to_string())?;
        }
    }
    Ok((out, w, h))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: u32, h: u32) -> Vec<u8> {
        (0..w * h)
            .flat_map(|i| [(i % 251) as u8, 20, 200, 255])
            .collect()
    }

    #[test]
    fn png_and_jpeg_carry_their_signatures_and_the_size() {
        let f = frame(64, 32);
        let (png, w, h) = encode(&f, 64, 32, Format::Png, 80, None).unwrap();
        assert_eq!((w, h), (64, 32));
        assert_eq!(&png[..8], b"\x89PNG\r\n\x1a\n");
        let (jpeg, w, h) = encode(&f, 64, 32, Format::Jpeg, 80, None).unwrap();
        assert_eq!((w, h), (64, 32));
        assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
    }

    #[test]
    fn a_width_scales_down_keeping_the_aspect_and_never_up() {
        let f = frame(200, 100);
        let (_, w, h) = encode(&f, 200, 100, Format::Png, 80, Some(50)).unwrap();
        assert_eq!((w, h), (50, 25));
        let (_, w, h) = encode(&f, 200, 100, Format::Png, 80, Some(900)).unwrap();
        assert_eq!((w, h), (200, 100));
    }

    #[test]
    fn scaling_averages_and_a_flat_colour_stays_flat() {
        let flat: Vec<u8> = (0..16 * 16).flat_map(|_| [10, 20, 30, 255]).collect();
        let (out, w, h) = scale_bgra(&flat, 16, 16, 4);
        assert_eq!((w, h), (4, 4));
        assert!(out.chunks_exact(4).all(|p| p == [10, 20, 30, 255]));
    }

    #[test]
    fn a_frame_of_the_wrong_length_is_refused() {
        assert!(encode(&[0; 10], 4, 4, Format::Png, 80, None).is_err());
    }
}
