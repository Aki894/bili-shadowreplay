fn main() {
    #[cfg(feature = "gui")]
    {
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
            // Tauri checks resource paths during compilation, before the bundle
            // hook populates this generated directory with the verified SDK.
            std::fs::create_dir_all("target/ffmpeg-runtime")
                .expect("create Linux runtime staging directory");
        }
        tauri_build::build();
    }
}
