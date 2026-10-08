fn main() {
    // Rebuild when CI/release env changes so credentials are re-baked into the binary.
    println!("cargo:rerun-if-env-changed=SUPABASE_FUNCTIONS_URL");
    println!("cargo:rerun-if-env-changed=SUPABASE_ANON_KEY");
    println!("cargo:rerun-if-env-changed=PHARMABUDDY_PROFILE");
    println!("cargo:rerun-if-env-changed=PHARMABUDDY_REQUIRE_LOGIN");
    println!("cargo:rerun-if-env-changed=PHARMABUDDY_SUPPORT_CONTACT");
    println!("cargo:rerun-if-env-changed=PHARMABUDDY_LOGIN_EMAIL_DOMAIN");

    tauri_build::build()
}
