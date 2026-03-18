use std::collections::HashMap;

pub(crate) const MAX_PLAYERS: usize = 8;
const MAX_PENDING_INPUT_BATCHES: usize = 64;

#[derive(Debug)]
pub(crate) struct PlayerSlots {
    slots: Vec<Option<String>>,
}

impl PlayerSlots {
    pub(crate) fn new() -> Self {
        Self {
            slots: vec![None; MAX_PLAYERS],
        }
    }

    pub(crate) fn slot_for_client(&self, client_id: &str) -> Option<usize> {
        self.slots
            .iter()
            .position(|slot| slot.as_deref() == Some(client_id))
    }

    pub(crate) fn assign_client(&mut self, client_id: &str) -> (Option<usize>, bool) {
        if let Some(existing_slot) = self.slot_for_client(client_id) {
            return (Some(existing_slot), false);
        }

        let slot = self.slots.iter().position(Option::is_none);
        if let Some(slot) = slot {
            self.slots[slot] = Some(client_id.to_string());
            return (Some(slot), true);
        }

        (None, false)
    }

    pub(crate) fn release_client(&mut self, client_id: &str) -> bool {
        let Some(slot) = self.slot_for_client(client_id) else {
            return false;
        };
        self.slots[slot] = None;
        true
    }

    pub(crate) fn count(&self) -> usize {
        self.slots.iter().filter(|slot| slot.is_some()).count()
    }
}

impl Default for PlayerSlots {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Default)]
pub(crate) struct PendingInputs {
    pending: HashMap<String, Vec<Vec<u8>>>,
}

impl PendingInputs {
    pub(crate) fn queue_client(&mut self, client_id: &str, payload: Vec<u8>) {
        let bucket = self
            .pending
            .entry(client_id.to_string())
            .or_insert_with(Vec::new);
        bucket.push(payload);
        if bucket.len() > MAX_PENDING_INPUT_BATCHES {
            let overflow = bucket.len().saturating_sub(MAX_PENDING_INPUT_BATCHES);
            if overflow > 0 {
                bucket.drain(0..overflow);
            }
        }
    }

    pub(crate) fn drain_client(&mut self, client_id: &str) -> Vec<Vec<u8>> {
        self.pending.remove(client_id).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_slots_assigns_until_full_and_reuses_existing_slot() {
        let mut slots = PlayerSlots::new();

        for idx in 0..MAX_PLAYERS {
            let (slot, is_new) = slots.assign_client(&format!("s{idx}"));
            assert_eq!(slot, Some(idx));
            assert!(is_new);
        }

        let (slot, is_new) = slots.assign_client("overflow");
        assert_eq!(slot, None);
        assert!(!is_new);

        let (slot, is_new) = slots.assign_client("s3");
        assert_eq!(slot, Some(3));
        assert!(!is_new);
        assert_eq!(slots.count(), MAX_PLAYERS);

        assert!(slots.release_client("s3"));
        assert_eq!(slots.count(), MAX_PLAYERS - 1);

        let (slot, is_new) = slots.assign_client("newcomer");
        assert_eq!(slot, Some(3));
        assert!(is_new);
        assert_eq!(slots.count(), MAX_PLAYERS);
    }

    #[test]
    fn pending_inputs_caps_batches_and_drops_oldest() {
        let mut pending = PendingInputs::default();

        for idx in 0..(MAX_PENDING_INPUT_BATCHES + 3) {
            pending.queue_client("sid", vec![idx as u8]);
        }

        let drained = pending.drain_client("sid");
        assert_eq!(drained.len(), MAX_PENDING_INPUT_BATCHES);
        assert_eq!(drained[0], vec![3u8]);
        assert_eq!(
            drained[drained.len() - 1],
            vec![(MAX_PENDING_INPUT_BATCHES + 2) as u8]
        );
    }
}
