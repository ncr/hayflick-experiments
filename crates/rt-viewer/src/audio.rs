//! Synth-blip audio backend: the sim's `AudioCue`s (and a couple of
//! presentation-side tells) rendered as code-generated 8-bit-style
//! waveforms through cpal. NO asset files — every sound is a short
//! square/sine/noise voice with a pitch sweep and a quadratic decay, which
//! lands squarely in the pixel-iso aesthetic and keeps the repo lean.
//!
//! Deliberately presentation-only and fail-soft: `AudioOut::new` returns
//! `None` on any device trouble (headless boxes, CI), the sim never knows,
//! and SHOT/DEMO captures stay byte-identical by construction.

use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

#[derive(Clone, Copy)]
enum Wave {
    Square,
    Sine,
    Noise,
}

#[derive(Clone, Copy)]
struct Voice {
    wave: Wave,
    f0: f32,
    f1: f32,
    dur: f32,  // seconds
    gain: f32, // 0..1 pre-master
    t: f32,
    phase: f32,
    rng: u32, // per-voice noise state
}

pub struct AudioOut {
    _stream: cpal::Stream,
    queue: Arc<Mutex<Vec<Voice>>>,
    master: f32,
}

impl AudioOut {
    /// Open the default output device. `None` = stay silent forever (no
    /// device, no permission, headless) — callers just skip play() calls.
    pub fn new(master: f32) -> Option<AudioOut> {
        let host = cpal::default_host();
        let device = host.default_output_device()?;
        let config = device.default_output_config().ok()?;
        let rate = config.sample_rate().0 as f32;
        let channels = config.channels() as usize;
        let queue: Arc<Mutex<Vec<Voice>>> = Arc::new(Mutex::new(Vec::new()));
        let q = queue.clone();
        let stream = device
            .build_output_stream(
                &config.into(),
                move |out: &mut [f32], _| {
                    let mut voices = q.lock().unwrap();
                    for frame in out.chunks_mut(channels) {
                        let mut s = 0.0f32;
                        for v in voices.iter_mut() {
                            let k = (v.t / v.dur).min(1.0);
                            let env = (1.0 - k) * (1.0 - k);
                            let f = v.f0 + (v.f1 - v.f0) * k;
                            let x = match v.wave {
                                Wave::Square => {
                                    v.phase = (v.phase + f / rate).fract();
                                    if v.phase < 0.5 { 1.0 } else { -1.0 }
                                }
                                Wave::Sine => {
                                    v.phase = (v.phase + f / rate).fract();
                                    (v.phase * std::f32::consts::TAU).sin()
                                }
                                Wave::Noise => {
                                    // xorshift32, resampled down to ~f Hz steps
                                    v.phase += f / rate;
                                    if v.phase >= 1.0 {
                                        v.phase = v.phase.fract();
                                        v.rng ^= v.rng << 13;
                                        v.rng ^= v.rng >> 17;
                                        v.rng ^= v.rng << 5;
                                    }
                                    (v.rng as f32 / u32::MAX as f32) * 2.0 - 1.0
                                }
                            };
                            s += x * env * v.gain;
                            v.t += 1.0 / rate;
                        }
                        voices.retain(|v| v.t < v.dur);
                        let s = (s * 0.5).clamp(-1.0, 1.0);
                        for ch in frame.iter_mut() {
                            *ch = s;
                        }
                    }
                },
                |e| eprintln!("audio: stream error: {e}"),
                None,
            )
            .ok()?;
        stream.play().ok()?;
        Some(AudioOut { _stream: stream, queue, master })
    }

    fn voice(&self, wave: Wave, f0: f32, f1: f32, dur: f32, gain: f32) {
        let mut q = self.queue.lock().unwrap();
        // cap simultaneous voices — a shotgun volley into a split-chain can
        // emit a dozen cues in one tick; drop the oldest instead of clipping
        if q.len() > 24 {
            q.remove(0);
        }
        q.push(Voice { wave, f0, f1, dur, gain: gain * self.master, t: 0.0, phase: 0.0, rng: 0x9e3779b9 });
    }

    /// One sim cue → one or two synth voices. Unknown ids stay silent (a
    /// new cue is a design decision, not a crash).
    pub fn play(&self, id: &str, gain: f32) {
        let g = gain;
        match id {
            "door_open" => self.voice(Wave::Square, 105.0, 140.0, 0.16, 0.30 * g),
            "door_close" => self.voice(Wave::Square, 140.0, 95.0, 0.16, 0.30 * g),
            // presentation-side: menu navigation blips
            "menu_move" => self.voice(Wave::Square, 520.0, 520.0, 0.025, 0.18 * g),
            "menu_pick" => {
                self.voice(Wave::Square, 520.0, 700.0, 0.05, 0.22 * g);
                self.voice(Wave::Sine, 700.0, 940.0, 0.07, 0.18 * g);
            }
            // presentation-side: footstep tick (walk cadence)
            "step" => {
                self.voice(Wave::Square, 210.0, 150.0, 0.022, 0.14 * g);
                self.voice(Wave::Noise, 1200.0, 800.0, 0.015, 0.06 * g);
            }
            _ => {}
        }
    }
}
