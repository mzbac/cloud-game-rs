use crossbeam_channel::Receiver;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tracing::{error, warn};

use worker::libretro::Core;

use crate::room::{InputEvent, Room};

pub(crate) fn spawn_emulator_thread(mut core: Core, fps: f64, input_receiver: Receiver<InputEvent>, room: Arc<Room>) {
    let tick = Duration::from_secs_f64(1.0 / fps.max(1.0));
    let idle_tick = Duration::from_millis(50);
    thread::spawn(move || loop {
        while let Ok(input) = input_receiver.try_recv() {
            if let Some(player) = room.player_index_for_session(&input.session_id) {
                if let Err(err) = core.update_input_state(player, &input.data) {
                    warn!(
                        session_id = input.session_id,
                        player,
                        error = %err,
                        "input update error"
                    );
                }
            } else {
                room.queue_pending_input(&input.session_id, input.data);
            }
        }

        if !room.has_video_sessions() {
            thread::sleep(idle_tick);
            continue;
        }

        let start = Instant::now();
        if let Err(err) = core.run_once() {
            error!(error = %err, "core run_once failed");
            break;
        }

        if let Some(wait) = tick.checked_sub(start.elapsed()) {
            thread::sleep(wait);
        }
    });
}
