#[cfg(windows)]
#[derive(Clone, Copy)]
struct Tone(f64, f64, f64, f64, f64, u8);

#[cfg(windows)]
fn tones(pack: &str, level: &str) -> &'static [Tone] {
    match (pack, level) {
        ("crystal", "crit") => &[Tone(880.0,880.0,0.0,0.13,0.24,1),Tone(698.46,698.46,0.11,0.13,0.24,1),Tone(587.33,587.33,0.22,0.22,0.26,1)],
        ("crystal", "warn") => &[Tone(659.25,659.25,0.0,0.15,0.20,1),Tone(493.88,493.88,0.12,0.20,0.18,1)],
        ("crystal", _) => &[Tone(1046.50,1046.50,0.0,0.24,0.18,1),Tone(1318.51,1318.51,0.07,0.26,0.18,1),Tone(1567.98,1567.98,0.14,0.30,0.20,1),Tone(1975.53,1975.53,0.21,0.36,0.17,1)],
        ("arcade", "crit") => &[Tone(880.0,830.0,0.0,0.09,0.22,2),Tone(659.25,622.25,0.10,0.09,0.22,2),Tone(523.25,493.88,0.20,0.18,0.24,2)],
        ("arcade", "warn") => &[Tone(698.46,698.46,0.0,0.09,0.19,2),Tone(523.25,523.25,0.10,0.14,0.19,2)],
        ("arcade", _) => &[Tone(987.77,987.77,0.0,0.09,0.20,2),Tone(1318.51,1318.51,0.08,0.28,0.22,2)],
        ("minimal", "crit") => &[Tone(660.0,620.0,0.0,0.11,0.24,3),Tone(660.0,520.0,0.13,0.16,0.25,3)],
        ("minimal", "warn") => &[Tone(480.0,360.0,0.0,0.14,0.21,3)],
        ("minimal", _) => &[Tone(520.0,960.0,0.0,0.17,0.23,3)],
        (_, "crit") => &[Tone(783.99,783.99,0.0,0.10,0.24,0),Tone(783.99,783.99,0.11,0.10,0.24,0),Tone(587.33,554.37,0.22,0.22,0.26,0)],
        (_, "warn") => &[Tone(523.25,523.25,0.0,0.12,0.20,0),Tone(659.25,659.25,0.10,0.18,0.20,0)],
        _ => &[Tone(587.33,587.33,0.0,0.20,0.20,0),Tone(880.0,880.0,0.09,0.24,0.21,0),Tone(1318.51,1318.51,0.18,0.34,0.22,0)],
    }
}

#[cfg(windows)]
fn synthesize(pack: &str, level: &str) -> Vec<u8> {
    const RATE: usize = 44_100;
    let steps = tones(pack, level);
    let duration = steps.iter().fold(0.25_f64, |end, t| end.max(t.2 + t.3 + 0.04));
    let count = (RATE as f64 * duration) as usize;
    let mut frames = vec![[0.0_f64; 2]; count];
    for &Tone(start_freq, end_freq, start, duration, gain, wave) in steps {
        let first = (start * RATE as f64) as usize;
        let len = ((duration * RATE as f64) as usize).max(1);
        let mut phase = [0.0, 0.0];
        for (i, frame) in frames.iter_mut().skip(first).take(len).enumerate() {
            let progress = i as f64 / len as f64;
            let t = i as f64 / RATE as f64;
            let freq = start_freq + (end_freq - start_freq) * progress;
            let attack = if t < 0.008 { t / 0.008 } else { 1.0 };
            let mut decay = (-4.6 * progress).exp() * (1.0 - progress * 0.25);
            if progress > 0.92 { decay *= (1.0 - progress) / 0.08; }
            let env = attack * decay.max(0.0) * gain;
            phase[0] += std::f64::consts::TAU * freq / RATE as f64;
            phase[1] += std::f64::consts::TAU * freq * 1.0035 / RATE as f64;
            for channel in 0..2 {
                let p = if wave == 3 { phase[0] } else { phase[channel] };
                let signal = match wave {
                    1 => p.sin()*0.78 + (p*2.756).sin()*0.22*(-3.0*progress).exp(),
                    2 => p.sin()*0.72 + (p*3.0).sin()*0.20 + (p*5.0).sin()*0.08,
                    3 => p.sin(),
                    _ => p.sin()*0.74 + (p*2.0).sin()*0.20 + (p*3.0).sin()*0.06,
                };
                frame[channel] += signal * env;
            }
        }
    }
    let bytes = (count * 4) as u32;
    let mut wav = Vec::with_capacity(44 + bytes as usize);
    wav.extend_from_slice(b"RIFF"); wav.extend_from_slice(&(36 + bytes).to_le_bytes());
    wav.extend_from_slice(b"WAVEfmt "); wav.extend_from_slice(&16_u32.to_le_bytes());
    wav.extend_from_slice(&1_u16.to_le_bytes()); wav.extend_from_slice(&2_u16.to_le_bytes());
    wav.extend_from_slice(&(RATE as u32).to_le_bytes()); wav.extend_from_slice(&((RATE * 4) as u32).to_le_bytes());
    wav.extend_from_slice(&4_u16.to_le_bytes()); wav.extend_from_slice(&16_u16.to_le_bytes());
    wav.extend_from_slice(b"data"); wav.extend_from_slice(&bytes.to_le_bytes());
    for frame in frames { for sample in frame { wav.extend_from_slice(&((sample.clamp(-0.96, 0.96) * 32767.0) as i16).to_le_bytes()); } }
    wav
}

#[cfg(windows)]
pub fn play(pack: &str, level: &str) {
    if pack.is_empty() || pack.eq_ignore_ascii_case("off") { return; }
    let pack = pack.to_ascii_lowercase();
    let level = level.to_ascii_lowercase();
    std::thread::spawn(move || {
        #[link(name = "winmm")]
        extern "system" { fn PlaySoundA(sound: *const u8, module: isize, flags: u32) -> i32; }
        let wav = synthesize(&pack, &level);
        // SND_MEMORY | SND_NODEFAULT; synchronous playback keeps the buffer alive.
        if unsafe { PlaySoundA(wav.as_ptr(), 0, 0x0004 | 0x0002) } == 0 { eprintln!("Could not play notification sound"); }
    });
}

#[cfg(not(windows))]
pub fn play(_pack: &str, _level: &str) {}
