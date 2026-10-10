use fframes::{
    CombinedMediaProvider, EncoderOptions, MediaDirectory, MediaProvider, RenderOptions,
    StaticMediaProvider, cli,
};
use fframes_skia_renderer::{
    SkiaFFramesRenderer, SkiaPipelineConcurrencyPolicy, SkiaPipelineConfig, metal::SkiaMetalCtx,
};
use std::process::ExitCode;
use wraith_launch::{HEIGHT, LaunchMedia, LaunchVideo, WIDTH};

fn main() -> ExitCode {
    let args = cli::parse::<cli::NoArgs>();
    let media = LaunchMedia::prepare().expect("media");
    // Site footage is decoded at render time, so it lives outside the embedded media folder.
    let footage_dir = MediaDirectory::read_folder(concat!(env!("CARGO_MANIFEST_DIR"), "/footage"))
        .expect("footage folder (run `node capture/record.mjs` first)");
    let footage = footage_dir.process_media_source().expect("footage");
    let combined = CombinedMediaProvider::from([
        &media as &dyn MediaProvider,
        &footage as &dyn MediaProvider,
    ]);
    let video = LaunchVideo::new(&media);
    let gpu = SkiaMetalCtx::new(WIDTH, HEIGHT).expect("GPU context");
    cli::new(
        &video,
        RenderOptions {
            media: Some(&combined),
            video_encoder_options: EncoderOptions {
                preferred_encoder: Some("libx264"),
                codec_params: Some(&[("crf", "16"), ("preset", "slow"), ("tune", "animation")]),
                ..Default::default()
            },
            ..Default::default()
        },
    )
    .args(args)
    .backend(
        SkiaFFramesRenderer::new_metal(
            &gpu,
            SkiaPipelineConfig {
                concurrency_policy: SkiaPipelineConcurrencyPolicy::MaxPerformance,
                ..Default::default()
            },
        )
        .expect("skia renderer"),
    )
    .preview(fframes_native_player::cli_preview)
    .run()
}
