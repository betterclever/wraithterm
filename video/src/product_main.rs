use fframes::{
    CombinedMediaProvider, EncoderOptions, MediaDirectory, MediaProvider, RenderOptions,
    StaticMediaProvider, cli,
};
use fframes_skia_renderer::{SkiaFFramesRenderer, SkiaPipelineConfig, metal::SkiaMetalCtx};
use std::process::ExitCode;
use wraith_launch::{LaunchMedia, product::ProductVideo};
fn main() -> ExitCode {
    let args = cli::parse::<cli::NoArgs>();
    let fonts = LaunchMedia::prepare().expect("bundled fonts");
    let dir = MediaDirectory::read_folder(concat!(env!("CARGO_MANIFEST_DIR"), "/footage"))
        .expect("footage directory");
    let footage = dir
        .process_media_source()
        .expect("decoded footage and stereo score");
    let combined =
        CombinedMediaProvider::from([&fonts as &dyn MediaProvider, &footage as &dyn MediaProvider]);
    let video = ProductVideo::new();
    for shader in video.shaders() {
        if let Err(e) = fframes_skia_renderer::render::compile_shader(shader) {
            eprintln!("Shader compilation failed: {e}");
            return ExitCode::FAILURE;
        }
    }
    let gpu = SkiaMetalCtx::new(1920, 1080).expect("Metal GPU");
    cli::new(
        &video,
        RenderOptions {
            media: Some(&combined),
            audio_encoder_options: EncoderOptions {
                preferred_encoder: Some("aac"),
                sample_rate: 48_000,
                bitrate: Some(320_000),
                ..Default::default()
            },
            video_encoder_options: EncoderOptions {
                preferred_encoder: Some("libx264"),
                codec_params: Some(&[("crf", "17"), ("preset", "medium")]),
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .args(args)
    .backend(
        SkiaFFramesRenderer::new_metal(&gpu, SkiaPipelineConfig::default())
            .expect("Skia GPU renderer"),
    )
    .preview(fframes_native_player::cli_preview)
    .default_output("wraith-product.mp4")
    .run()
}
