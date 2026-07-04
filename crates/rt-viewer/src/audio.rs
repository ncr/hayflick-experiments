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
            "pistol_fire" => {
                self.voice(Wave::Noise, 3400.0, 900.0, 0.09, 0.50 * g);
                self.voice(Wave::Square, 220.0, 70.0, 0.06, 0.25 * g);
            }
            // ---- per-weapon fire voices (arena arsenal): each gun gets its
            // own report so the hand FEELS different per slot
            "fire_slug" => {
                // heavy single crack: broadband snap + a deep body thump
                self.voice(Wave::Noise, 2600.0, 350.0, 0.16, 0.60 * g);
                self.voice(Wave::Square, 130.0, 42.0, 0.18, 0.50 * g);
            }
            "fire_uzi" => {
                // short snappy chatter tick — quiet enough to stack at 12/s
                self.voice(Wave::Noise, 3200.0, 1300.0, 0.045, 0.38 * g);
                self.voice(Wave::Square, 340.0, 170.0, 0.035, 0.22 * g);
            }
            "fire_shotgun" => {
                // broad boom: long noise wash over a low pressure wave
                self.voice(Wave::Noise, 1700.0, 220.0, 0.22, 0.62 * g);
                self.voice(Wave::Square, 92.0, 48.0, 0.15, 0.45 * g);
            }
            "fire_grenade" => {
                // hollow launcher thoonk (the BOOM comes later, on Detonated)
                self.voice(Wave::Sine, 175.0, 62.0, 0.18, 0.55 * g);
                self.voice(Wave::Noise, 850.0, 320.0, 0.06, 0.20 * g);
            }
            "fire_harpoon" => {
                // rail whip: fast metallic downsweep + air crack
                self.voice(Wave::Square, 1500.0, 190.0, 0.12, 0.32 * g);
                self.voice(Wave::Noise, 2800.0, 700.0, 0.08, 0.35 * g);
            }
            "boom" => {
                // grenade detonation: long low rumble + sub thud + debris hiss
                self.voice(Wave::Noise, 950.0, 55.0, 0.50, 0.70 * g);
                self.voice(Wave::Sine, 72.0, 26.0, 0.45, 0.60 * g);
                self.voice(Wave::Square, 52.0, 30.0, 0.20, 0.30 * g);
            }
            "wave_land" => {
                // squad drop: deep door-slam + a rising two-note warning
                self.voice(Wave::Sine, 58.0, 36.0, 0.45, 0.55 * g);
                self.voice(Wave::Noise, 420.0, 95.0, 0.30, 0.30 * g);
                self.voice(Wave::Square, 494.0, 494.0, 0.09, 0.22 * g);
                self.voice(Wave::Square, 660.0, 660.0, 0.14, 0.22 * g);
            }
            "goo_hit" => self.voice(Wave::Sine, 190.0, 115.0, 0.08, 0.55 * g),
            "goo_split" => {
                self.voice(Wave::Sine, 420.0, 180.0, 0.12, 0.45 * g);
                self.voice(Wave::Noise, 1800.0, 500.0, 0.10, 0.30 * g);
            }
            "goo_die" => self.voice(Wave::Sine, 150.0, 55.0, 0.20, 0.55 * g),
            "goo_merge" => self.voice(Wave::Sine, 180.0, 400.0, 0.22, 0.40 * g),
            "goo_solidify" => {
                self.voice(Wave::Noise, 900.0, 250.0, 0.05, 0.55 * g);
                self.voice(Wave::Square, 95.0, 70.0, 0.10, 0.35 * g);
            }
            "door_open" => self.voice(Wave::Square, 105.0, 140.0, 0.16, 0.30 * g),
            "door_close" => self.voice(Wave::Square, 140.0, 95.0, 0.16, 0.30 * g),
            "switch" => self.voice(Wave::Square, 780.0, 780.0, 0.03, 0.35 * g),
            "pickup" => self.voice(Wave::Square, 660.0, 990.0, 0.08, 0.35 * g),
            "eat" => self.voice(Wave::Sine, 330.0, 210.0, 0.12, 0.35 * g),
            "target_hit" => self.voice(Wave::Square, 880.0, 880.0, 0.06, 0.35 * g),
            "card_pick" => {
                self.voice(Wave::Square, 520.0, 780.0, 0.08, 0.35 * g);
                self.voice(Wave::Square, 780.0, 1180.0, 0.10, 0.30 * g);
            }
            "player_down" => {
                self.voice(Wave::Square, 320.0, 34.0, 0.75, 0.55 * g);
                self.voice(Wave::Noise, 2400.0, 200.0, 0.45, 0.35 * g);
            }
            "lights_out" => {
                self.voice(Wave::Square, 160.0, 30.0, 1.1, 0.45 * g);
                self.voice(Wave::Sine, 90.0, 28.0, 1.3, 0.40 * g);
            }
            "breach" => {
                self.voice(Wave::Square, 240.0, 120.0, 0.18, 0.45 * g);
                self.voice(Wave::Noise, 700.0, 250.0, 0.14, 0.30 * g);
            }
            "shift_done" => {
                self.voice(Wave::Square, 392.0, 392.0, 0.14, 0.30 * g);
                self.voice(Wave::Square, 494.0, 494.0, 0.22, 0.30 * g);
                self.voice(Wave::Square, 587.0, 784.0, 0.5, 0.35 * g);
            }
            // presentation-side: the comm-pact blink tick (per rising edge)
            "comm_blink" => self.voice(Wave::Sine, 1250.0, 1250.0, 0.035, 0.30 * g),
            "impact" => {
                // round dies on a hard surface: tiny debris thip
                self.voice(Wave::Noise, 2100.0, 550.0, 0.035, 0.24 * g);
                self.voice(Wave::Square, 160.0, 110.0, 0.02, 0.10 * g);
            }
            // presentation-side: menu navigation blips
            "menu_move" => self.voice(Wave::Square, 520.0, 520.0, 0.025, 0.18 * g),
            "menu_pick" => {
                self.voice(Wave::Square, 520.0, 700.0, 0.05, 0.22 * g);
                self.voice(Wave::Square, 700.0, 940.0, 0.07, 0.18 * g);
            }
            // presentation-side: hover-servo step tick (walk cadence)
            "step" => {
                self.voice(Wave::Square, 210.0, 150.0, 0.022, 0.14 * g);
                self.voice(Wave::Noise, 1200.0, 800.0, 0.015, 0.06 * g);
            }
            _ => {}
        }
    }
}
