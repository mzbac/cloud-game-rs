use openh264::encoder::{Complexity, EncoderConfig, UsageType};

fn main() {
    let _config = EncoderConfig::new()
        .usage_type(UsageType::ScreenContentRealTime)
        .complexity(Complexity::Low);
}
