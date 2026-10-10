fn main() {
    if let Ok(path) = std::env::var("WRAITH_NATIVE_DIR") {
        println!("cargo:rustc-link-search=native={path}");
        println!("cargo:rustc-link-lib=static=wraith-bridge");
        println!("cargo:rustc-link-lib=static=ghostty-vt");
        println!("cargo:rerun-if-changed={path}/libwraith-bridge.a");
        println!("cargo:rerun-if-changed={path}/libghostty-vt.a");
        if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
            println!("cargo:rustc-link-lib=System");
        }
    }
    println!("cargo:rerun-if-env-changed=WRAITH_NATIVE_DIR");
}
