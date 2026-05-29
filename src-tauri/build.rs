fn main() {
    // Rebuild when CI/release env changes so credentials are re-baked into the binary.
    println!("cargo:rerun-if-env-changed=SUPABASE_FUNCTIONS_URL");
    println!("cargo:rerun-if-env-changed=SUPABASE_ANON_KEY");
    println!("cargo:rerun-if-env-changed=PHARMABUDDY_PROFILE");

    tauri_build::build()
}
