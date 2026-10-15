//! Commands that carry bytes (thumbnails, preview clips, files made in the
//! window, smart-search vectors) get them as one raw request body instead of
//! JSON, where every byte would travel as a number written out in text
//! (about 3.5 times the size, and slow to parse on both sides).
//!
//! The body: 4 bytes JSON length (little-endian), the other arguments as
//! JSON, then the bytes (api.ts `rawBody`).

use serde::de::DeserializeOwned;

/// Split a body into its arguments and its bytes.
pub fn split<T: DeserializeOwned>(body: &[u8]) -> Result<(T, &[u8]), String> {
    let bad = || "The data didn't arrive whole.".to_string();
    let n = u32::from_le_bytes(body.get(..4).ok_or_else(bad)?.try_into().map_err(|_| bad())?) as usize;
    let json = body.get(4..4usize.checked_add(n).ok_or_else(bad)?).ok_or_else(bad)?;
    let args: T = serde_json::from_slice(json).map_err(|x| format!("The data didn't arrive whole: {x}"))?;
    Ok((args, &body[4 + n..]))
}

/// The arguments and bytes of a command called with a raw body.
pub fn request<'a, T: DeserializeOwned>(request: &'a tauri::ipc::Request<'_>) -> Result<(T, &'a [u8]), String> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err("The data didn't arrive (it was sent the old way).".into());
    };
    split(body)
}

/// Little-endian 32-bit floats.
pub fn floats(b: &[u8]) -> Result<Vec<f32>, String> {
    if !b.len().is_multiple_of(4) {
        return Err("The data didn't arrive whole.".into());
    }
    Ok(b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize, Debug, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Args {
        id: i64,
        duration_ms: Option<i64>,
    }

    fn body(json: &str, bytes: &[u8]) -> Vec<u8> {
        let mut b = (json.len() as u32).to_le_bytes().to_vec();
        b.extend_from_slice(json.as_bytes());
        b.extend_from_slice(bytes);
        b
    }

    #[test]
    fn splits_arguments_from_bytes() {
        let b = body(r#"{"id":7,"durationMs":null}"#, &[0, 1, 255]);
        let (a, bytes): (Args, &[u8]) = split(&b).unwrap();
        assert_eq!(a, Args { id: 7, duration_ms: None });
        assert_eq!(bytes, &[0, 1, 255]);
        let empty = body(r#"{"id":1}"#, &[]);
        let (_, none): (Args, &[u8]) = split(&empty).unwrap();
        assert!(none.is_empty());
        assert!(split::<Args>(&b[..3]).is_err());
        assert!(split::<Args>(&body(r#"{"id":1}"#, &[])[..8]).is_err());
        assert!(split::<Args>(&[255, 255, 255, 255, 1]).is_err());
        assert!(split::<Args>(&body("{}", &[1])).is_err(), "missing id");
        assert_eq!(floats(&[0, 0, 128, 63, 0, 0, 0, 64]).unwrap(), vec![1.0, 2.0]);
        assert!(floats(&[0, 0, 128]).is_err());
    }
}
