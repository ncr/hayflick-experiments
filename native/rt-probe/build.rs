use std::process::Command;

fn main() {
    let out_dir = std::env::var("OUT_DIR").unwrap();
    for (src, stage) in [("src/shaders/trace.comp", "comp"), ("src/shaders/tonemap.comp", "comp")] {
        println!("cargo:rerun-if-changed={src}");
        let name = std::path::Path::new(src).file_name().unwrap().to_str().unwrap();
        let spv = format!("{out_dir}/{name}.spv");
        let status = Command::new("glslangValidator")
            .args(["--target-env", "vulkan1.3", "-S", stage, "-o", &spv, src])
            .status()
            .expect("failed to run glslangValidator — is it on PATH? (pkg: glslang)");
        assert!(status.success(), "shader compilation failed for {src}");
    }
}
