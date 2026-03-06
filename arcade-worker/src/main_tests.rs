use super::*;
use super::video_sender::{fill_rgba_buffer_from_frame, h264_contains_idr};

#[test]
fn rgba_from_xrgb8888_converts_bgrx_to_rgba() {
    let mut frame = VideoFrame::new(
        worker::RetroPixelFormat::Xrgb8888,
        2,
        1,
        8,
        vec![
            0x00, 0x00, 0xff, 0x00, // red pixel
            0x00, 0xff, 0x00, 0x00, // green pixel
        ],
    );

    let mut out = Vec::new();
    let rgba = fill_rgba_buffer_from_frame(&mut frame, &mut out).expect("rgba");
    assert_eq!(rgba, &[0xff, 0x00, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff]);
}

#[test]
fn rgba_from_rgb565_converts_to_rgba() {
    let mut data = Vec::new();
    for raw in [0xf800u16, 0x07e0u16, 0x001fu16] {
        data.extend_from_slice(&raw.to_le_bytes());
    }

    let mut frame = VideoFrame::new(worker::RetroPixelFormat::Rgb565, 3, 1, 6, data);

    let mut out = Vec::new();
    let rgba = fill_rgba_buffer_from_frame(&mut frame, &mut out).expect("rgba");
    assert_eq!(
        rgba,
        &[
            0xff, 0x00, 0x00, 0xff, // red
            0x00, 0xff, 0x00, 0xff, // green
            0x00, 0x00, 0xff, 0xff, // blue
        ]
    );
}

#[test]
fn rgba_from_rgb1555_converts_to_rgba() {
    let mut data = Vec::new();
    for raw in [0x7c00u16, 0x03e0u16, 0x001fu16] {
        data.extend_from_slice(&raw.to_le_bytes());
    }

    let mut frame = VideoFrame::new(worker::RetroPixelFormat::Rgb1555, 3, 1, 6, data);

    let mut out = Vec::new();
    let rgba = fill_rgba_buffer_from_frame(&mut frame, &mut out).expect("rgba");
    assert_eq!(
        rgba,
        &[
            0xff, 0x00, 0x00, 0xff, // red
            0x00, 0xff, 0x00, 0xff, // green
            0x00, 0x00, 0xff, 0xff, // blue
        ]
    );
}

#[test]
fn rgba_from_frame_rejects_short_stride() {
    let mut frame = VideoFrame::new(
        worker::RetroPixelFormat::Xrgb8888,
        1,
        2,
        4,
        vec![0, 0, 0, 0],
    );

    let mut out = Vec::new();
    assert!(fill_rgba_buffer_from_frame(&mut frame, &mut out).is_none());
}

#[test]
fn h264_idr_detection_annexb_and_avcc() {
    let annexb_idr = [0, 0, 0, 1, 0x65, 0x00];
    assert!(h264_contains_idr(&annexb_idr));

    let annexb_non_idr = [0, 0, 0, 1, 0x61, 0x00];
    assert!(!h264_contains_idr(&annexb_non_idr));

    let annexb_three_byte = [0, 0, 1, 0x65, 0x00];
    assert!(h264_contains_idr(&annexb_three_byte));

    let avcc_idr = [0, 0, 0, 2, 0x65, 0x00];
    assert!(h264_contains_idr(&avcc_idr));

    let avcc_non_idr = [0, 0, 0, 2, 0x61, 0x00];
    assert!(!h264_contains_idr(&avcc_non_idr));
}
