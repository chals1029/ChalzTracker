//! Local QR Code encoder backed by the `qrcode` crate (Error Correction Level L).
//! Generates QR matrices purely in-process so secret companion links never touch third parties.

use qrcode::{Color, EcLevel, QrCode};
use serde::Serialize;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QrMatrix {
    pub size: usize,
    pub rows: Vec<String>,
}

pub fn encode_qr_matrix(data: &[u8]) -> Result<QrMatrix, String> {
    if data.is_empty() {
        return Err("Cannot generate QR code for empty payload.".to_owned());
    }
    let code = QrCode::with_error_correction_level(data, EcLevel::L)
        .map_err(|_| "Link is too long for local QR generation.".to_owned())?;
    let size = code.width();
    let colors = code.to_colors();

    let mut rows = Vec::with_capacity(size);
    for row_colors in colors.chunks_exact(size) {
        let mut row = String::with_capacity(size);
        for &color in row_colors {
            row.push(match color {
                Color::Dark => '1',
                Color::Light => '0',
            });
        }
        rows.push(row);
    }

    Ok(QrMatrix { size, rows })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_companion_url_into_square_qr_matrix() {
        let sample = format!(
            "https://chalztracker.vercel.app/companion/#{}",
            "A".repeat(220)
        );
        let qr = encode_qr_matrix(sample.as_bytes()).unwrap();
        assert_eq!(qr.rows.len(), qr.size);
        assert!(qr
            .rows
            .iter()
            .all(|r| r.len() == qr.size && r.bytes().all(|b| b == b'0' || b == b'1')));
        // Top-left finder pattern center 3x3 dark block at (2..=4, 2..=4).
        for r in 2..=4 {
            assert_eq!(&qr.rows[r][2..=4], "111");
        }
        // Always-dark module at (size - 8, 8).
        assert_eq!(qr.rows[qr.size - 8].as_bytes()[8], b'1');
    }

    #[test]
    fn rejects_empty_and_oversized_payloads() {
        assert!(encode_qr_matrix(b"").is_err());
        let too_big = vec![b'x'; 4000];
        assert!(encode_qr_matrix(&too_big).is_err());
    }
}
