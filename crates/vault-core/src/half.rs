//! IEEE 754 half-precision (16-bit) floats, for storing smart-search vectors
//! at half the size. Plenty for unit vectors: each value keeps about three
//! and a half significant digits, so similarity scores move by about 0.0001.

/// The nearest half-precision value (ties to even), as its bits.
pub fn to_f16(x: f32) -> u16 {
    let b = x.to_bits();
    let sign = ((b >> 16) & 0x8000) as u16;
    let exp = ((b >> 23) & 0xff) as i32;
    let man = b & 0x7f_ffff;
    if exp == 0xff {
        // Infinity or NaN (NaN stays NaN).
        return sign | 0x7c00 | if man != 0 { 0x200 } else { 0 };
    }
    let e = exp - 127 + 15;
    if e >= 0x1f {
        return sign | 0x7c00; // too big: infinity
    }
    if e <= 0 {
        // Below the smallest normal half: a subnormal, or zero.
        if e < -10 {
            return sign;
        }
        let m = man | 0x80_0000;
        let shift = (14 - e) as u32;
        let half = 1u32 << (shift - 1);
        let mut r = m >> shift;
        let rest = m & ((1u32 << shift) - 1);
        if rest > half || (rest == half && r & 1 == 1) {
            r += 1;
        }
        return sign | r as u16;
    }
    let mut r = ((e as u32) << 10) | (man >> 13);
    let rest = man & 0x1fff;
    if rest > 0x1000 || (rest == 0x1000 && r & 1 == 1) {
        r += 1; // may carry into the exponent, which is still right
    }
    sign | r as u16
}

pub fn from_f16(h: u16) -> f32 {
    let sign = ((h & 0x8000) as u32) << 16;
    let exp = ((h >> 10) & 0x1f) as u32;
    let man = (h & 0x3ff) as u32;
    let bits = if exp == 0 {
        if man == 0 {
            sign
        } else {
            let mut e: i32 = 1;
            let mut m = man;
            while m & 0x400 == 0 {
                m <<= 1;
                e -= 1;
            }
            sign | (((e + 127 - 15) as u32) << 23) | ((m & 0x3ff) << 13)
        }
    } else if exp == 0x1f {
        sign | 0x7f80_0000 | (man << 13)
    } else {
        sign | ((exp + 127 - 15) << 23) | (man << 13)
    };
    f32::from_bits(bits)
}

/// Little-endian f32 values -> little-endian f16 values.
pub fn f32_blob_to_f16(b: &[u8]) -> Vec<u8> {
    b.chunks_exact(4).flat_map(|c| to_f16(f32::from_le_bytes([c[0], c[1], c[2], c[3]])).to_le_bytes()).collect()
}

pub fn f32s_to_f16_blob(v: &[f32]) -> Vec<u8> {
    v.iter().flat_map(|x| to_f16(*x).to_le_bytes()).collect()
}

/// Little-endian f16 values -> f32 values.
pub fn f16_blob_to_f32(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(2).map(|c| from_f16(u16::from_le_bytes([c[0], c[1]]))).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_half_value_round_trips() {
        for h in 0..=u16::MAX {
            let f = from_f16(h);
            if f.is_nan() {
                assert!(from_f16(to_f16(f)).is_nan());
                continue;
            }
            assert_eq!(to_f16(f), h, "{h:#06x} = {f}");
        }
    }

    #[test]
    fn rounds_to_the_nearest_half() {
        let mut x = 0x1234_5678u32;
        for _ in 0..200_000 {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            let f = f32::from_bits(x);
            if !f.is_finite() || f.abs() > 65000.0 {
                continue;
            }
            let h = to_f16(f);
            let got = from_f16(h);
            // No other half value is closer.
            for n in [h.wrapping_sub(1), h.wrapping_add(1)] {
                let other = from_f16(n);
                if other.is_finite() && (n & 0x7fff) < 0x7c00 && (n ^ h) & 0x8000 == 0 {
                    assert!((got - f).abs() <= (other - f).abs(), "{f}: {got} vs {other}");
                }
            }
        }
        assert_eq!(from_f16(to_f16(0.1)), 0.099975586);
        assert_eq!(from_f16(to_f16(-1.0)), -1.0);
        assert_eq!(from_f16(to_f16(1e-7)), 1.1920929e-7);
        assert_eq!(to_f16(1e-9), 0);
        assert!(from_f16(to_f16(1e6)).is_infinite());
    }
}
